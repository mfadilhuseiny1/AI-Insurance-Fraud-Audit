package com.palantir.transforms.lang.java.testing.api;

import org.apache.spark.sql.SparkSession;
import org.junit.rules.ExternalResource;

/** JUnit 4 (deprecated): a local SparkSession as a @ClassRule (shared by a class) or a @Rule (one per test). */
public final class SparkSessionResource extends ExternalResource {
    private SparkSession session;

    @Override
    protected void before() {
        get();
    }

    @Override
    protected void after() {
        if (session != null) {
            session.stop();
            session = null;
        }
    }

    public SparkSession get() {
        if (session == null) session = TestSessions.create();
        return session;
    }
}
