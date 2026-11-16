from myproject.datasets.bpjs_common import edisi_of
from myproject.datasets.bpjs_spec import GO_REPAIR, SPEC, select_sql


def test_edisi_dari_nama_file():
    assert edisi_of("202403_fkrtl.dta") == "reguler"
    assert edisi_of("COV20152024_fkrtl.dta") == "covid"
    assert edisi_of("KIA2024ibu_fkrtl.dta") == "kia_ibu"
    assert edisi_of("KIA2024anak_fkrtl.dta") == "kia_anak"
    assert edisi_of("KM2024_fkrtl.dta") == "kesehatan_mental"


def test_kolom_berlabel_jadi_kode_dan_teks():
    sel, joins = select_sql("kepesertaan", {"PSTV01", "PSTV08", "edisi"})
    assert "segmen_kode" in sel and "AS segmen" in sel and "LEFT JOIN lab" in joins


def test_kolom_tidak_ada_jadi_null():
    sel, _ = select_sql("fkrtl", {"FKL02", "edisi"})
    assert "NULL AS layanan_covid" in sel


def test_nama_silver_unik():
    for tabel, spec in SPEC.items():
        names = [n for _, n, _ in spec]
        assert len(names) == len(set(names)), tabel


def test_perbaikan_go_hanya_menambah_go():
    for bad, good in GO_REPAIR.items():
        assert good.replace("go", "", 1) == bad or bad in good.replace("go", "")
