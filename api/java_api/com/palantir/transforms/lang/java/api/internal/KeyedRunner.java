package com.palantir.transforms.lang.java.api.internal;

import com.palantir.foundry.udf.api.RowBuilderFactory;
import com.palantir.foundry.udf.api.Values;
import com.palantir.foundry.udf.api.keyed.FoundryKeyedProcessUdf;
import com.palantir.foundry.udf.api.keyed.KeyedState;
import com.palantir.foundry.udf.api.keyed.TimeDomain;
import com.palantir.foundry.udf.api.keyed.TimerService;
import java.time.Instant;
import java.util.*;

/**
 * Runs a keyed process UDF over records in order (UdfMain "run" for keyed process UDFs):
 *
 * - each record's key is the JSON list of its key column values; the UDF sees that key's state and timers only;
 * - the watermark follows the event times with no out-of-orderness (as Flink's forMonotonousTimestamps): a record at
 *   event time t first moves the watermark to t - 1 ms and fires the event-time timers at or before it, in time
 *   order, then is processed (so a window timer at its end - 1 ms fires before the next window's first record);
 *   processing-time timers at or before `now` fire after the records;
 * - `final` (a batch build: the input is bounded) fires every remaining event-time timer at the end;
 * - state, timers and the watermark come in with the spec and go back with the result, so a streaming job keeps
 *   them in its checkpoint between micro-batches.
 */
final class KeyedRunner {
    private static final int MAX_FIRES = 1_000_000;

    private record Timer(String key, long time) implements Comparable<Timer> {
        public int compareTo(Timer o) {
            int c = Long.compare(time, o.time);
            return c != 0 ? c : key.compareTo(o.key);
        }
    }

    private final FoundryKeyedProcessUdf udf;
    private final List<String> keyColumns;
    private final String eventTimeColumn;
    private final Map<String, Map<String, Object>> state = new LinkedHashMap<>();
    private final TreeSet<Timer> eventTimers = new TreeSet<>();
    private final TreeSet<Timer> processingTimers = new TreeSet<>();
    private final long now;
    private long watermark = Long.MIN_VALUE;
    private int fires;
    final List<Map<String, Object>> out = new ArrayList<>();

    @SuppressWarnings("unchecked")
    KeyedRunner(FoundryKeyedProcessUdf udf, List<String> keyColumns, String eventTimeColumn, Map<String, Object> saved, long now) {
        this.udf = udf;
        this.keyColumns = keyColumns;
        this.eventTimeColumn = eventTimeColumn == null || eventTimeColumn.isEmpty() ? null : eventTimeColumn;
        this.now = now;
        if (saved == null) return;
        Map<String, Object> st = (Map<String, Object>) saved.get("state");
        if (st != null) st.forEach((k, v) -> state.put(k, (Map<String, Object>) v));
        List<Map<String, Object>> timers = (List<Map<String, Object>>) saved.get("timers");
        if (timers != null) {
            for (Map<String, Object> t : timers) {
                Timer timer = new Timer((String) t.get("key"), ((Number) t.get("time")).longValue());
                ("PROCESSING_TIME".equals(t.get("domain")) ? processingTimers : eventTimers).add(timer);
            }
        }
        if (saved.get("watermark") instanceof Number) watermark = ((Number) saved.get("watermark")).longValue();
    }

    /** An event time as epoch milliseconds: timestamps / ISO text, or epoch numbers (milliseconds from 1e11, else seconds). */
    static Long millis(Object v) {
        if (v == null || "".equals(v)) return null;
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            return (long) (Math.abs(d) >= 1e11 ? d : d * 1000);
        }
        String s = v.toString().trim();
        if (s.matches("-?\\d+(\\.\\d+)?")) return millis(Double.parseDouble(s));
        return Values.toTimestamp(s).toEpochMilli();
    }

    void run(List<Map<String, Object>> rows, boolean bounded) throws Exception {
        for (Map<String, Object> row : rows) {
            List<Object> key = new ArrayList<>();
            for (String c : keyColumns) key.add(Values.plain(row.get(c)));
            String k = Main.JSON.writeValueAsString(key);
            Long et = eventTimeColumn == null ? null : millis(row.get(eventTimeColumn));
            if (et != null && et - 1 > watermark) {
                watermark = et - 1;
                fireEventTimers(watermark);
            }
            udf.processElement(new Ctx(k, key, et, null, null), row, out::add);
        }
        fireProcessingTimers();
        if (bounded) fireEventTimers(Long.MAX_VALUE);
    }

    private void fireEventTimers(long upTo) throws Exception {
        while (!eventTimers.isEmpty() && eventTimers.first().time() <= upTo) fire(eventTimers.pollFirst(), TimeDomain.EVENT_TIME);
    }

    private void fireProcessingTimers() throws Exception {
        while (!processingTimers.isEmpty() && processingTimers.first().time() <= now) fire(processingTimers.pollFirst(), TimeDomain.PROCESSING_TIME);
    }

    @SuppressWarnings("unchecked")
    private void fire(Timer t, TimeDomain domain) throws Exception {
        if (++fires > MAX_FIRES) throw new IllegalStateException("more than " + MAX_FIRES + " timers fired in one run: does onTimer register a timer at or before its own time?");
        List<Object> key = Main.JSON.readValue(t.key(), List.class);
        udf.onTimer(new Ctx(t.key(), key, domain == TimeDomain.EVENT_TIME ? t.time() : null, t.time(), domain), out::add);
    }

    Map<String, Object> saved() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("state", state);
        List<Map<String, Object>> timers = new ArrayList<>();
        for (Timer t : eventTimers) timers.add(Map.of("key", t.key(), "time", t.time(), "domain", "EVENT_TIME"));
        for (Timer t : processingTimers) timers.add(Map.of("key", t.key(), "time", t.time(), "domain", "PROCESSING_TIME"));
        m.put("timers", timers);
        m.put("watermark", watermark == Long.MIN_VALUE ? null : watermark);
        return m;
    }

    private final class Ctx implements FoundryKeyedProcessUdf.OnTimerContext, KeyedState, TimerService {
        private final String key;
        private final List<Object> keyValues;
        private final Long eventTime;
        private final Long timestamp;
        private final TimeDomain domain;

        Ctx(String key, List<Object> keyValues, Long eventTime, Long timestamp, TimeDomain domain) {
            this.key = key;
            this.keyValues = Collections.unmodifiableList(keyValues);
            this.eventTime = eventTime;
            this.timestamp = timestamp;
            this.domain = domain;
        }

        public RowBuilderFactory getRowBuilderFactory() {
            return RowBuilderFactory.INSTANCE;
        }

        public List<Object> currentKey() {
            return keyValues;
        }

        public Instant eventTime() {
            return eventTime == null ? null : Instant.ofEpochMilli(eventTime);
        }

        public KeyedState state() {
            return this;
        }

        public TimerService timerService() {
            return this;
        }

        public Instant timestamp() {
            if (timestamp == null) throw new IllegalStateException("timestamp() is only set in onTimer");
            return Instant.ofEpochMilli(timestamp);
        }

        public TimeDomain timeDomain() {
            if (domain == null) throw new IllegalStateException("timeDomain() is only set in onTimer");
            return domain;
        }

        // KeyedState
        public Map<String, Object> get() {
            return state.get(key);
        }

        public void set(Map<String, Object> value) {
            if (value == null) state.remove(key);
            else state.put(key, Values.plainMap(value));
        }

        public void clear() {
            state.remove(key);
        }

        // TimerService
        public Instant currentWatermark() {
            return watermark == Long.MIN_VALUE ? null : Instant.ofEpochMilli(watermark);
        }

        public Instant currentProcessingTime() {
            return Instant.ofEpochMilli(now);
        }

        public void registerEventTimeTimer(Instant time) {
            eventTimers.add(new Timer(key, time.toEpochMilli()));
        }

        public void registerProcessingTimeTimer(Instant time) {
            processingTimers.add(new Timer(key, time.toEpochMilli()));
        }

        public void deleteEventTimeTimer(Instant time) {
            eventTimers.remove(new Timer(key, time.toEpochMilli()));
        }

        public void deleteProcessingTimeTimer(Instant time) {
            processingTimers.remove(new Timer(key, time.toEpochMilli()));
        }
    }
}
