package com.palantir.transforms.lang.java.testing.api;

import java.io.File;
import org.apache.spark.sql.SparkSession;

/** The local Spark session tests get (no UI, small shuffles, UTC). */
final class TestSessions {
    private TestSessions() {}

    static SparkSession create() {
        String tmp = System.getProperty("java.io.tmpdir");
        return SparkSession.builder()
                .master("local[2]")
                .appName("Java transform tests")
                .config("spark.ui.enabled", "false")
                .config("spark.ui.showConsoleProgress", "false")
                .config("spark.driver.host", "127.0.0.1")
                .config("spark.driver.bindAddress", "127.0.0.1")
                .config("spark.sql.shuffle.partitions", "2")
                .config("spark.sql.session.timeZone", "UTC")
                .config("spark.sql.warehouse.dir", new File(tmp, "spark-warehouse").toURI().toString())
                .getOrCreate();
    }
}
