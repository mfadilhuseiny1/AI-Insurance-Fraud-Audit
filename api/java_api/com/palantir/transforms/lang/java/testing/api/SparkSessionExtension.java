package com.palantir.transforms.lang.java.testing.api;

import org.apache.spark.sql.SparkSession;
import org.junit.jupiter.api.extension.AfterAllCallback;
import org.junit.jupiter.api.extension.BeforeAllCallback;
import org.junit.jupiter.api.extension.ExtensionContext;

/** JUnit 5: a local SparkSession shared by the tests of a class. Register with @RegisterExtension, then sparkSession.get(). */
public final class SparkSessionExtension implements BeforeAllCallback, AfterAllCallback {
    private SparkSession session;

    @Override
    public void beforeAll(ExtensionContext context) {
        get();
    }

    @Override
    public void afterAll(ExtensionContext context) {
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
