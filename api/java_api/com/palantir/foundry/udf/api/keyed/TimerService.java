package com.palantir.foundry.udf.api.keyed;

import java.time.Instant;

/**
 * Timers of the current key. An event-time timer fires once the watermark (the latest event time seen) reaches it;
 * a processing-time timer fires once the job's clock does. Registering the same time twice keeps one timer.
 * Timers are checkpointed with the state, so they survive restarts of a streaming job.
 */
public interface TimerService {
    Instant currentWatermark();

    Instant currentProcessingTime();

    void registerEventTimeTimer(Instant time);

    void registerProcessingTimeTimer(Instant time);

    void deleteEventTimeTimer(Instant time);

    void deleteProcessingTimeTimer(Instant time);
}
