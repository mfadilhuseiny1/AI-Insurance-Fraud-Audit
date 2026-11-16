package com.palantir.foundry.udf.api.keyed;

import java.util.Map;

/** The state of the current key as plain values (the generated adapters give UDFs a typed state object). */
public interface KeyedState {
    /** null when the key has no state yet (or it was cleared) */
    Map<String, Object> get();

    void set(Map<String, Object> value);

    void clear();
}
