"""Contracts of the stream's other events, beside the FKRTL claim (aip/layanan.KlaimIn): an FKTP visit and a
non-capitation claim, in the fields of the silver datasets kunjungan_fktp and tindakan_nonkapitasi."""

from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class FktpIn(BaseModel):
    """One FKTP visit (capitation), with its referral when it was referred."""
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    kunjungan_fktp_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    edisi: str = Field("reguler", pattern=r"^[a-z_]+$")
    peserta_id: int = Field(ge=0)
    tgl_datang: date
    tgl_pulang: Optional[date] = None
    kabkota_fktp_kode: int = Field(ge=1100, le=9999)
    kabkota_fktp: Optional[str] = Field(None, max_length=120)
    provinsi_fktp: Optional[str] = Field(None, max_length=120)
    kepemilikan_fktp: str = Field(max_length=80)
    jenis_fktp: str = Field(max_length=80)
    tipe_fktp: Optional[str] = Field(None, max_length=80)
    tingkat_pelayanan: Optional[str] = Field(None, max_length=20)
    poli: Optional[str] = Field(None, max_length=80)
    jenis_kunjungan: Optional[str] = Field(None, max_length=40)
    status_pulang: Optional[str] = Field(None, max_length=40)
    dx_icd3: Optional[str] = Field(None, max_length=8)
    kabkota_rujukan_kode: Optional[int] = None
    kepemilikan_rujukan: Optional[str] = Field(None, max_length=80)
    jenis_faskes_rujukan: Optional[str] = Field(None, max_length=80)
    tipe_faskes_rujukan: Optional[str] = Field(None, max_length=80)
    poli_rujukan: Optional[str] = Field(None, max_length=80)


class NonkapIn(BaseModel):
    """One non-capitation procedure claim of an FKTP (or a laboratory/midwife network)."""
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    kunjungan_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    edisi: str = Field("reguler", pattern=r"^[a-z_]+$")
    peserta_id: int = Field(ge=0)
    tgl_kunjungan: date
    tgl_tindakan: Optional[date] = None
    tgl_pulang: Optional[date] = None
    kabkota_faskes_kode: int = Field(ge=1100, le=9999)
    kabkota_faskes: Optional[str] = Field(None, max_length=120)
    provinsi_faskes: Optional[str] = Field(None, max_length=120)
    kepemilikan_faskes: str = Field(max_length=80)
    jenis_faskes: str = Field(max_length=80)
    tipe_faskes: Optional[str] = Field(None, max_length=80)
    tingkat_layanan: Optional[str] = Field(None, max_length=20)
    dx_icd3: Optional[str] = Field(None, max_length=8)
    dx_kode: Optional[str] = Field(None, max_length=16)
    tindakan: str = Field(min_length=1, max_length=300)
    tindakan_ke: Optional[int] = Field(None, ge=0, le=1000)
    biaya_tagih_rp: int = Field(ge=0, le=10_000_000_000)
