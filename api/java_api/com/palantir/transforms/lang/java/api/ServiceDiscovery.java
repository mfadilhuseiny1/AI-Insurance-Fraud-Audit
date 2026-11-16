package com.palantir.transforms.lang.java.api;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * URIs of the platform's services, by name ("api" is this server's API), and the token to call the API with: a
 * short-lived token for the user who started the build (a schedule: its creator), valid while the build runs. Send
 * it as {@code Authorization: Bearer <token>} ({@link #authorizationHeader()}); it is empty when sign-in is off.
 */
public final class ServiceDiscovery {
    private final Map<String, List<String>> uris;
    private final String apiToken;

    public ServiceDiscovery(Map<String, List<String>> uris) {
        this(uris, "");
    }

    public ServiceDiscovery(Map<String, List<String>> uris, String apiToken) {
        this.uris = uris;
        this.apiToken = apiToken == null ? "" : apiToken;
    }

    public List<String> getUris(String service) {
        return uris.getOrDefault(service, Collections.emptyList());
    }

    public Map<String, List<String>> getAllUris() {
        return Collections.unmodifiableMap(uris);
    }

    /** The API token of this build (empty when sign-in is off). */
    public Optional<String> apiToken() {
        return apiToken.isEmpty() ? Optional.empty() : Optional.of(apiToken);
    }

    /** "Bearer <token>" for the Authorization header, when there is a token. */
    public Optional<String> authorizationHeader() {
        return apiToken().map(t -> "Bearer " + t);
    }
}
