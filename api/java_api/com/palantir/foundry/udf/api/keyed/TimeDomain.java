package com.palantir.foundry.udf.api.keyed;

/** Which clock a timer runs on: the records' event time (the watermark) or the job's processing time. */
public enum TimeDomain {
    EVENT_TIME,
    PROCESSING_TIME
}
