package com.palantir.foundry.udf.api.keyed;

import com.palantir.foundry.udf.api.RowBuilderFactory;
import com.palantir.foundry.udf.api.flatmap.Collector;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * A keyed process UDF as the runtime calls it (like Flink's KeyedProcessFunction): records are partitioned by the key
 * columns, and each call sees the state and timers of its record's key only. Zero or more rows out per record and per
 * timer. In a streaming pipeline the state and timers are kept across micro-batches (in the job's checkpoint); in a
 * batch build they start empty and every event-time timer fires at the end of the input.
 */
public interface FoundryKeyedProcessUdf {
    interface Context {
        RowBuilderFactory getRowBuilderFactory();

        /** the values of the key columns, in the order of keyColumns */
        List<Object> currentKey();

        /** the record's event time (eventTimeColumn); null in onTimer of a processing-time timer or without an event time column */
        Instant eventTime();

        KeyedState state();

        TimerService timerService();
    }

    interface OnTimerContext extends Context {
        Instant timestamp();

        TimeDomain timeDomain();
    }

    void processElement(Context ctx, Map<String, Object> row, Collector<Map<String, Object>> out) throws Exception;

    default void onTimer(OnTimerContext ctx, Collector<Map<String, Object>> out) throws Exception {}
}
