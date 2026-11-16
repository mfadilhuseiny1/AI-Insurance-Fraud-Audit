package com.palantir.transforms.lang.java.api;

import java.util.Collections;
import java.util.Map;
import org.apache.spark.sql.SparkSession;

/** What a compute function can use besides its inputs: the Spark session, transform parameters, service URIs. */
public final class TransformContext {
    private final SparkSession session;
    private final Map<String, Object> parameters;
    private final ServiceDiscovery services;

    /** Built by the runner. */
    public TransformContext(SparkSession session, Map<String, Object> parameters, ServiceDiscovery services) {
        this.session = session;
        this.parameters = Collections.unmodifiableMap(parameters);
        this.services = services;
    }

    public SparkSession sparkSession() {
        return session;
    }

    /** The transform's parameters (repoSettings.json "javaParameters": "*" for every transform, or by transform). */
    public Map<String, Object> parameters() {
        return parameters;
    }

    /** Builds here run with no user token: always empty. */
    public String authHeader() {
        return "";
    }

    public ServiceDiscovery serviceDiscovery() {
        return services;
    }
}
