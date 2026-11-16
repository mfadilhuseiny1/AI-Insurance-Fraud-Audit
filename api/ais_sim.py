"""Synthetic AIS traffic in Jakarta Bay for the Map demo (timeseries_demo.py): what an AIS base station at Tanjung
Priok would receive.

Every vessel follows an operating plan, a repeating sequence of segments (sailing a route, at anchor, moored,
fishing, out of receiver range), so a position is a function of time: the history, the live feed and a catch-up
after a gap all agree, and a restart picks up where the ships are.

* Container ships and a tanker arrive from the shipping lanes (Sunda Strait, the Java Sea, north to Singapore),
  wait at the Priok anchorage, shift to their berth (NPCT1 at Kalibaru, JICT, the oil jetty) with a tug alongside,
  stay moored for the port call and sail out again, until they leave receiver range;
* two cargo ships lie at the anchorage, swinging round their anchors with the tide;
* tugs wait at the tug pool, run out to meet a ship, escort it in or out and return;
* ferries keep the Kepulauan Seribu timetables (WIB): the express boat Marina Ancol - Pulau Pramuka, the public
  ferry Muara Angke (Kaliadem) - Pulau Tidung and the Ancol - Untung Jawa shuttle every two hours;
* fishing boats (AIS class B) leave Muara Angke in the late afternoon, trawl through the night and come back at
  dawn;
* a KPLP patrol boat sails a loop of the bay with a stop.

Messages follow ITU-R M.1371: class A reports every 10 s under way (6 s above 14 knots) and every 3 minutes at
anchor, moored or below 3 knots; class B every 30 s above 2 knots, else every 3 minutes. Speed and course over
ground come from the movement itself. As received from the air, about 4 % of messages are lost, positions jitter
by a few metres, a few messages carry no fix (latitude 91, longitude 181), class B boats send no heading (511),
and course is noise at very low speed.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

Point = tuple[float, float]
WIB = 7 * 3600  # Western Indonesia Time (UTC+7): the ferry and fishing timetables

NAV_STATUS = {0: "Under way using engine", 1: "At anchor", 3: "Restricted manoeuvrability", 5: "Moored", 7: "Engaged in fishing"}


def noise(*parts: object) -> float:
    """A deterministic value in [-1, 1) for the parts."""
    h = hashlib.sha1("|".join(map(str, parts)).encode()).digest()
    return int.from_bytes(h[:4], "big") / 2**31 - 1


def km(a: Point, b: Point) -> float:
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    return 6371 * math.hypot(dlat, dlon)


def bearing(a: Point, b: Point) -> float:
    return (math.degrees(math.atan2((b[1] - a[1]) * math.cos(math.radians(a[0])), b[0] - a[0])) + 360) % 360


def offset(p: Point, north_m: float, east_m: float) -> Point:
    return p[0] + north_m / 111_320, p[1] + east_m / (111_320 * math.cos(math.radians(p[0])))


# ------------------------------------------------------------------------------------------------
# places (approximate)
# ------------------------------------------------------------------------------------------------

# Tanjung Priok: outer channel, breakwater entrance, inner basin, berths, tug pool, KPLP base
PRIOK_OUTER = (-6.0700, 106.8860)
PRIOK_ENTRANCE = (-6.0865, 106.8860)
PRIOK_BASIN = (-6.0960, 106.8870)
JICT = (-6.1005, 106.8945)
OIL_JETTY = (-6.0950, 106.8785)
TUG_POOL = (-6.0978, 106.8828)
KPLP = (-6.0988, 106.8805)
# NPCT1 at Kalibaru faces the open bay
NPCT1_APPROACH = (-6.0740, 106.9200)
NPCT1 = (-6.0880, 106.9235)
# the anchorage north of the port
ANCHORAGE = {"a1": (-6.0120, 106.9150), "a2": (-6.0320, 106.8680), "a3": (-6.0400, 106.9350), "a4": (-6.0250, 106.8900), "a5": (-6.0450, 106.9050)}
# where the shipping lanes leave receiver range
LANE_WEST = [(-5.8600, 106.1500), (-5.9000, 106.4000), (-5.9400, 106.6200), (-6.0000, 106.7800)]  # Sunda Strait
LANE_EAST = [(-5.6800, 107.5500), (-5.8000, 107.2000), (-5.8800, 106.9800)]  # Java Sea
LANE_NORTH = [(-5.4000, 106.9500), (-5.8000, 106.9200)]  # to Singapore
# Kepulauan Seribu ferries
ANCOL = (-6.1215, 106.8425)
ANCOL_OUT = (-6.1100, 106.8425)
KALIADEM = (-6.1035, 106.7790)
KALIADEM_OUT = (-6.0850, 106.7780)
MUARA_ANGKE = (-6.1068, 106.7738)
MUARA_ANGKE_OUT = (-6.0880, 106.7760)
BAY_NW = (-6.0400, 106.7800)
UNTUNG_JAWA = (-5.9795, 106.7085)
PRAMUKA = (-5.7465, 106.6145)
TIDUNG = (-5.7985, 106.5060)


# ------------------------------------------------------------------------------------------------
# plan segments
# ------------------------------------------------------------------------------------------------


@dataclass
class Seg:
    kind: str  # route | moored | anchored | fishing | dark
    dur: float  # seconds
    status: int = 0
    destination: str = ""
    draught: float = 0.0
    # a tug escorts the ship through this segment
    assist: bool = False
    pos: Callable[[float], Optional[Point]] = lambda tau: None
    # moored: the heading at the berth; anchored: the anchor
    heading: Optional[float] = None
    anchor: Optional[Point] = None
    start: Optional[Point] = None
    end: Optional[Point] = None


def route(points: list[Point], knots: list[float], **kw) -> Seg:
    """Sail through the points; knots[i] is the speed from points[i] to points[i + 1]."""
    legs = []
    for i in range(len(points) - 1):
        secs = km(points[i], points[i + 1]) / (knots[i] * 1.852) * 3600
        legs.append((points[i], points[i + 1], max(secs, 1.0)))
    total = sum(s for _, _, s in legs)

    def pos(tau: float) -> Point:
        for a, b, s in legs:
            if tau <= s:
                f = tau / s
                return a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
            tau -= s
        return points[-1]

    return Seg("route", total, pos=pos, start=points[0], end=points[-1], **kw)


def moored(p: Point, hours: float, heading: float, **kw) -> Seg:
    return Seg("moored", hours * 3600, status=5, pos=lambda tau: p, heading=heading, start=p, end=p, **kw)


def anchored(p: Point, hours: float, **kw) -> Seg:
    """Swinging round the anchor on 80 m of chain: with the tide (12.4 h) and a slow yaw. The chain pays out over
    the first and is hove in over the last ten minutes, so the ship arrives at and leaves from the anchor."""
    dur = hours * 3600

    def pos(tau: float) -> Point:
        ang = math.radians(_swing(tau))
        r = 80 * max(0.0, min(1.0, tau / 600, (dur - tau) / 600))
        return offset(p, r * math.cos(ang), r * math.sin(ang))

    return Seg("anchored", dur, status=1, pos=pos, anchor=p, start=p, end=p, **kw)


def _swing(tau: float) -> float:
    return (360 * tau / 44_640 + 25 * math.sin(tau / 600)) % 360


def fishing(center: Point, hours: float, radius_m: float = 3500, **kw) -> Seg:
    """Trawling at about 3 knots in a Lissajous pattern that starts and ends at the centre."""
    dur = hours * 3600

    def pos(tau: float) -> Point:
        env = math.sin(math.pi * tau / dur)
        return offset(center, radius_m * env * math.sin(2 * math.pi * tau / 9000), radius_m * env * math.sin(2 * math.pi * tau / 12_000))

    return Seg("fishing", dur, status=7, pos=pos, start=center, end=center, **kw)


def dark(hours: float) -> Seg:
    """Out of receiver range: no messages."""
    return Seg("dark", hours * 3600)


# ------------------------------------------------------------------------------------------------
# vessels
# ------------------------------------------------------------------------------------------------


def _imo(n: int) -> int:
    """An IMO number with its check digit (n: the first six digits)."""
    d = str(n)
    return n * 10 + sum(int(c) * w for c, w in zip(d, range(7, 1, -1))) % 10


@dataclass
class Vessel:
    mmsi: int
    name: str
    callsign: str
    ship_type: int
    length: int
    cls: str  # A | B
    segs: list[Seg]
    # seconds added to the time before the plan is read; daily timetables use WIB - origin hour
    shift: float = 0.0
    imo: Optional[int] = None
    period: float = field(init=False)

    def __post_init__(self) -> None:
        self.period = sum(s.dur for s in self.segs)

    def at(self, t: float) -> tuple[Seg, float, float]:
        """The segment at time t (epoch seconds), the time into it and its absolute start."""
        local = t + self.shift
        k = math.floor(local / self.period)
        r = local - k * self.period
        base = t - r
        for s in self.segs:
            if r < s.dur:
                return s, r, base
            r -= s.dur
            base += s.dur
        s = self.segs[-1]
        return s, s.dur, base - s.dur

    def segments_near(self, t: float) -> list[tuple[Seg, float]]:
        """(segment, absolute start) of the plan cycles around t."""
        local = t + self.shift
        k = math.floor(local / self.period)
        out = []
        for c in (k - 1, k, k + 1):
            start = c * self.period - self.shift
            for s in self.segs:
                out.append((s, start))
                start += s.dur
        return out

    def position(self, t: float) -> Optional[Point]:
        s, tau, _ = self.at(t)
        return s.pos(tau)


def daily(origin_hour: float, items: list[tuple[Optional[float], Seg]], filler: Callable[[Point, float], Seg]) -> tuple[list[Seg], float]:
    """A daily timetable starting at origin_hour WIB: items are (start hour WIB or None = right after the previous
    one, segment); the gaps are filled with filler(at the previous end, hours). Returns the segments and the shift."""
    def until(h: float) -> float:
        gap = (h - clock) % 24
        return 0.0 if gap < 1e-6 or gap > 24 - 1e-6 else gap

    segs: list[Seg] = []
    clock = origin_hour
    at = items[0][1].start
    for start, seg in items:
        if start is not None:
            gap = until(start)
            if gap:
                segs.append(filler(at, gap))
                clock = start
        segs.append(seg)
        clock = (clock + seg.dur / 3600) % 24
        at = seg.end
    gap = until(origin_hour)
    if gap:
        segs.append(filler(at, gap))
    return segs, WIB - origin_hour * 3600


def _fleet() -> tuple[list[Vessel], list[tuple[Vessel, tuple[float, float], list[Vessel]]]]:
    a = ANCHORAGE
    into_priok = [PRIOK_OUTER, PRIOK_ENTRANCE, PRIOK_BASIN]
    vessels: list[Vessel] = []

    # container ship to NPCT1, from the north lane, out to the Java Sea
    cs1 = Vessel(525019237, "MV SINAR KALIBARU", "POKB", 71, 260, "A", [
        dark(5),
        route([*LANE_NORTH, a["a1"]], [15, 12], destination="IDTPP", draught=11.2),
        anchored(a["a1"], 3, destination="IDTPP", draught=11.2),
        route([a["a1"], NPCT1_APPROACH, NPCT1], [8, 3], destination="IDTPP", draught=11.2, assist=True, status=3),
        moored(NPCT1, 9, 165, destination="IDTPP", draught=10.4),
        route([NPCT1, NPCT1_APPROACH], [3], destination="IDSUB", draught=9.8, assist=True, status=3),
        route([NPCT1_APPROACH, *LANE_EAST[::-1]], [12, 15, 15], destination="IDSUB", draught=9.8),
    ], shift=11_000, imo=_imo(934512))
    # container ship to JICT, from and back to the Sunda Strait
    cs2 = Vessel(525003418, "MV TELUK MERAK", "POTM", 71, 190, "A", [
        dark(4),
        route([*LANE_WEST, a["a2"]], [15, 15, 14, 10], destination="IDTPP", draught=9.6),
        anchored(a["a2"], 2.5, destination="IDTPP", draught=9.6),
        route([a["a2"], *into_priok, JICT], [7, 4, 3, 1.5], destination="IDTPP", draught=9.6, assist=True, status=3),
        moored(JICT, 10, 75, destination="IDTPP", draught=8.9),
        route([JICT, PRIOK_BASIN, PRIOK_ENTRANCE, PRIOK_OUTER], [1.5, 3, 4], destination="SGSIN", draught=8.5, assist=True, status=3),
        route([PRIOK_OUTER, *LANE_WEST[::-1]], [10, 14, 15, 15], destination="SGSIN", draught=8.5),
    ], shift=31_000, imo=_imo(938820))
    # product tanker to the oil jetty, from and back to the Java Sea
    tk = Vessel(525007762, "MT GAS BAHARI", "POGB", 81, 180, "A", [
        dark(6),
        route([*LANE_EAST, a["a3"]], [12, 12, 10], destination="IDTPP", draught=10.8),
        anchored(a["a3"], 5, destination="IDTPP", draught=10.8),
        route([a["a3"], *into_priok, OIL_JETTY], [7, 4, 3, 1.5], destination="IDTPP", draught=10.8, assist=True, status=3),
        moored(OIL_JETTY, 14, 270, destination="IDTPP", draught=6.2),
        route([OIL_JETTY, PRIOK_BASIN, PRIOK_ENTRANCE, PRIOK_OUTER], [1.5, 3, 4], destination="IDBPN", draught=6.2, assist=True, status=3),
        route([PRIOK_OUTER, a["a3"], *LANE_EAST[::-1]], [10, 12, 12, 12], destination="IDBPN", draught=6.2),
    ], shift=52_000, imo=_imo(927154))
    # cargo ships waiting at the anchorage
    gc1 = Vessel(525012905, "KM MENTARI SAMUDRA", "POMS", 70, 120, "A", [anchored(a["a4"], 48, destination="IDTPP", draught=7.1)], imo=_imo(912377))
    gc2 = Vessel(525016644, "MV NUSA PERDANA", "PONP", 70, 145, "A", [anchored(a["a5"], 36, destination="IDTPP", draught=8.3)], shift=9_000, imo=_imo(919046))
    vessels += [cs1, cs2, tk, gc1, gc2]

    # tugs: wait at the tug pool, escort the ships they are assigned
    tug1 = Vessel(525100231, "TB PRIOK SATU", "YDPS", 52, 32, "A", [moored(TUG_POOL, 24, 0)])
    tug2 = Vessel(525100232, "TB PRIOK DUA", "YDPD", 52, 32, "A", [moored(offset(TUG_POOL, 0, 40), 24, 0)])
    vessels += [tug1, tug2]

    def ferry_filler(p: Point, hours: float) -> Seg:
        return moored(p, hours, 0, destination="", draught=1.8)

    # express boat Marina Ancol - Pulau Pramuka: out 08:00, back 14:30
    to_pramuka = [ANCOL, ANCOL_OUT, BAY_NW, (-5.9000, 106.6800), (-5.8000, 106.6300), PRAMUKA]
    segs, shift = daily(0, [
        (8.0, route(to_pramuka, [5, 22, 22, 22, 6], destination="P. PRAMUKA", draught=1.6)),
        (14.5, route(to_pramuka[::-1], [6, 22, 22, 22, 5], destination="MARINA ANCOL", draught=1.6)),
    ], ferry_filler)
    vessels.append(Vessel(525200118, "KM KILAT SERIBU 3", "YDKS", 60, 28, "A", segs, shift=shift))
    # public ferry Muara Angke (Kaliadem) - Pulau Tidung: out 07:00, back 13:00
    to_tidung = [KALIADEM, KALIADEM_OUT, (-6.0300, 106.7200), (-5.9300, 106.6000), (-5.8300, 106.5200), TIDUNG]
    segs, shift = daily(0, [
        (7.0, route(to_tidung, [4, 11, 11, 11, 4], destination="P. TIDUNG", draught=2.1)),
        (13.0, route(to_tidung[::-1], [4, 11, 11, 11, 4], destination="MUARA ANGKE", draught=2.1)),
    ], ferry_filler)
    vessels.append(Vessel(525200245, "KM LUMBA TELUK", "YDLT", 60, 36, "A", segs, shift=shift))
    # Ancol - Untung Jawa shuttle: every two hours from 07:00 to 17:00
    to_untung = [ANCOL, ANCOL_OUT, BAY_NW, UNTUNG_JAWA]
    trips: list[tuple[Optional[float], Seg]] = []
    for h in range(7, 18, 2):
        trips.append((float(h), route(to_untung, [5, 20, 14], destination="P. UNTUNG JAWA", draught=1.4)))
        trips.append((h + 1.0, route(to_untung[::-1], [14, 20, 5], destination="MARINA ANCOL", draught=1.4)))
    segs, shift = daily(0, trips, ferry_filler)
    vessels.append(Vessel(525200307, "KM ANCOL BAHARI", "YDAB", 60, 22, "A", segs, shift=shift))

    # fishing boats (class B): leave Muara Angke in the afternoon, fish through the night, back at dawn
    grounds = [(-5.8800, 106.8200), (-5.8400, 106.9800), (-5.9500, 106.6200)]
    for i, (name, ground, leave, back) in enumerate([("KM MINA JAYA 07", grounds[0], 16.5, 4.0), ("KM SRI REJEKI 2", grounds[1], 17.0, 3.5),
                                                      ("KM BINTANG LAUT 11", grounds[2], 17.5, 4.5)]):
        out = route([MUARA_ANGKE, MUARA_ANGKE_OUT, ground], [3, 7], destination="FISHING GROUND")
        home = route([ground, MUARA_ANGKE_OUT, MUARA_ANGKE], [7, 3], destination="MUARA ANGKE")
        fish_hours = (back - (leave + out.dur / 3600)) % 24
        segs, shift = daily(12, [(leave, out), (None, fishing(ground, fish_hours, radius_m=3000 + 600 * i)), (back, home)],
                            lambda p, hours: moored(p, hours, 350))
        vessels.append(Vessel(525300410 + i * 17, name, "", 30, 18 + i * 2, "B", segs, shift=shift))

    # KPLP patrol: a loop of the bay every 8 hours, with a stop off Pulau Bidadari
    loop = [KPLP, PRIOK_BASIN, PRIOK_ENTRANCE, (-6.0500, 106.8400), (-6.0300, 106.7600)]
    loop2 = [(-6.0300, 106.7600), (-5.9700, 106.8000), (-5.9800, 106.9200), (-6.0400, 106.9500), PRIOK_OUTER, PRIOK_ENTRANCE, PRIOK_BASIN, KPLP]
    stop = (-6.0300, 106.7600)
    vessels.append(Vessel(525400017, "KN TRISULA P.114", "YDTP", 55, 40, "A", [
        moored(KPLP, 3, 90),
        route(loop, [3, 4, 12, 12], destination="PATROL"),
        Seg("drift", 2400, status=0, destination="PATROL", pos=lambda tau: offset(stop, -tau * 0.08, tau * 0.05), start=stop, end=offset(stop, -192, 120)),
        route([offset(stop, -192, 120), *loop2[1:]], [12, 12, 12, 10, 4, 3, 3], destination="PATROL"),
    ], shift=4_000))
    # the tugs' station off the ship (metres north, east) and the ships they escort
    return vessels, [(tug1, (-40.0, -30.0), [cs1, tk]), (tug2, (-40.0, 30.0), [cs2, tk])]


VESSELS, _ESCORTS = _fleet()
TUG_RUN_S = 1500  # a tug's run between the tug pool and the ship


def _tug_position(tug: Vessel, off: tuple[float, float], ships: list[Vessel], t: float) -> Optional[tuple[Point, int]]:
    """Where an escorting tug is (and its status), or None when it is at the tug pool."""
    home = tug.segs[0].start
    assert home is not None
    for ship in ships:
        for seg, start in ship.segments_near(t):
            if not seg.assist:
                continue
            end = start + seg.dur
            if start - TUG_RUN_S <= t < start:
                meet = offset(seg.pos(0) or home, *off)
                f = (t - (start - TUG_RUN_S)) / TUG_RUN_S
                return (home[0] + (meet[0] - home[0]) * f, home[1] + (meet[1] - home[1]) * f), 0
            if start <= t < end:
                p = seg.pos(t - start) or home
                return offset(p, *off), 3
            if end <= t < end + TUG_RUN_S:
                leave = offset(seg.pos(seg.dur) or home, *off)
                f = (t - end) / TUG_RUN_S
                return (leave[0] + (home[0] - leave[0]) * f, leave[1] + (home[1] - leave[1]) * f), 0
    return None


def state(v: Vessel, t: float) -> Optional[dict]:
    """Position, status and voyage data of the vessel at t; None while it is out of receiver range."""
    seg, tau, start = v.at(t)
    status, heading = seg.status, seg.heading
    p = seg.pos(tau)
    prev = v.at(t - 5)
    pp = prev[0].pos(prev[1])
    for tug, off, ships in _ESCORTS:
        if tug is v:
            hit = _tug_position(v, off, ships, t)
            if hit:
                p, status = hit
                heading = None
                hp = _tug_position(v, off, ships, t - 5)
                pp = hp[0] if hp else pp
    if p is None:
        return None
    pp = pp or p
    dist_m = km(pp, p) * 1000
    sog = dist_m / 5 / 0.514444
    cog = bearing(pp, p) if dist_m > 0.5 else None
    if seg.kind == "anchored" and seg.anchor:
        hdg = (bearing(p, seg.anchor)) % 360  # bow to the anchor
    elif heading is not None and sog < 0.5:
        hdg = heading
    else:
        hdg = cog if cog is not None else (heading or 0.0)
    eta = datetime.fromtimestamp(start + seg.dur, timezone.utc) if seg.kind == "route" else None
    return {"lat": p[0], "lon": p[1], "sog": sog, "cog": cog, "heading": hdg, "status": status, "destination": seg.destination,
            "draught": seg.draught, "eta": eta}


def _interval(v: Vessel, st: dict) -> int:
    if v.cls == "B":
        return 30 if st["sog"] > 2 else 180
    if st["status"] in (1, 5) or st["sog"] < 3:
        return 180
    return 6 if st["sog"] > 14 else 10


def message(v: Vessel, t: int, st: dict) -> dict:
    """The decoded AIS position report (type 1 / 18) with the vessel's static and voyage data (type 5 / 24)."""
    j = lambda k: noise(v.mmsi, k, t)  # noqa: E731
    lat, lon = st["lat"] + 0.00003 * j("lat"), st["lon"] + 0.00003 * j("lon")
    sog = max(0.0, st["sog"] + (0.1 * j("sog") if st["sog"] > 0.3 else 0.05 * (j("sog") + 1)))
    cog = st["cog"] if st["cog"] is not None and st["sog"] > 0.5 else (st["heading"] + 60 * j("cog")) % 360
    heading = 511 if v.cls == "B" else round((st["heading"] + 2 * j("hdg")) % 360)
    if noise(v.mmsi, "fix", t) > 0.985:
        lat, lon = 91.0, 181.0  # no position available
    eta = st["eta"]
    return {
        "msg_type": 1 if v.cls == "A" else 18,
        "mmsi": str(v.mmsi),
        "imo": str(v.imo) if v.imo else None,
        "callsign": v.callsign or None,
        "vessel_name": v.name,
        "ship_type": v.ship_type,
        "length_m": v.length,
        "ts": datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z"),
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "sog": round(sog, 1),
        "cog": round(cog, 1),
        "heading": heading,
        "nav_status": st["status"] if v.cls == "A" else 15,
        "destination": st["destination"] or None,
        "eta": eta.strftime("%m-%d %H:%M") if eta else None,
        "draught": st["draught"] or None,
    }


def messages(t0: float, t1: float) -> list[dict]:
    """The messages received in [t0, t1), in time order."""
    out: list[tuple[int, int, dict]] = []
    first = math.ceil(t0 / 2) * 2
    for i, v in enumerate(VESSELS):
        phase = (v.mmsi % 90) * 2
        for t in range(first, math.ceil(t1), 2):
            k = t + phase
            if k % 6 and k % 10:
                continue
            st = state(v, t)
            if st is None:
                continue
            if k % _interval(v, st):
                continue
            if noise(v.mmsi, "lost", t) > 0.92:
                continue  # not received (range, collisions)
            out.append((t, i, message(v, t, st)))
    out.sort(key=lambda x: (x[0], x[1]))
    return [m for _, _, m in out]


def clean(m: dict) -> Optional[dict]:
    """What the demo's streaming pipeline does, for when it cannot run: drop messages without a fix, heading 511 to
    null, the status and vessel type as text, speed in km/h."""
    if not (-6.6 <= m["lat"] <= -5.2 and 105.9 <= m["lon"] <= 107.7):
        return None
    return {**m, "heading": None if m["heading"] == 511 else m["heading"], "nav_status_text": nav_status_text(m["nav_status"]),
            "vessel_type": vessel_type(m["ship_type"]), "speed_kmh": round(m["sog"] * 1.852, 1)}


def nav_status_text(code: int) -> str:
    return NAV_STATUS.get(code, "Not defined")


def vessel_type(code: int) -> str:
    if code == 30:
        return "Fishing"
    if code == 52:
        return "Tug"
    if code == 55:
        return "Law enforcement"
    if 60 <= code <= 69:
        return "Passenger"
    if 70 <= code <= 79:
        return "Cargo"
    if 80 <= code <= 89:
        return "Tanker"
    return "Other"

