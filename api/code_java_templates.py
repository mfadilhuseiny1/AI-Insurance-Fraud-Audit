"""Repository templates for Java (Code Repositories → New repository → Language template), as in Palantir's
"Getting started" with Java transforms and "User-defined functions" (Map UDF Definition/Implementation)."""

from __future__ import annotations

JAVA_README = """# {name}

Java transforms on Spark (local mode on this server), following Foundry's Transforms Java.

- `transforms-java/src/main/java/myproject/MyPipelineDefiner.java` adds the project's transforms to its Pipeline
  (`autoBindFromPackage("myproject.datasets")` registers every `@Compute` method with `@Input` / `@Output`
  annotations; `pipeline.register(HighLevelTransform.builder()…)` registers one by hand). It is named in
  `src/main/resources/META-INF/services/com.palantir.transforms.lang.java.api.PipelineDefiner`.
- High-level transforms take `Dataset<Row>` inputs and return the output `Dataset<Row>`; low-level ones take
  `FoundryInput` / `FoundryOutput` (DataFrames or files, several outputs, incremental read ranges and write modes).
- Inputs and outputs are Files paths (`/My Project/folder/dataset`) or item ids; a folder is read as files.
- `TransformContext` gives the Spark session and parameters (`repoSettings.json` → `javaParameters`).
- Tests: JUnit 5 in `src/test/java` with AssertJ, Mockito and `SparkSessionExtension`.
- Checks compile the project, list its transforms and run its tests on every commit.
"""

JAVA_BUILD_GRADLE = """// This server compiles with javac against Spark and the Transforms Java API. The dependencies below are honored for
// shared code from other repositories: add the repository in Settings -> Artifacts, then reference it, e.g.
//     compile 'ri.stemma.main.repository.<repo id>:transforms-java:<version>'
apply plugin: 'com.palantir.transforms.lang.java'
apply plugin: 'com.palantir.transforms.lang.java-defaults'

dependencies {
}
"""

JAVA_DEFINER = """package myproject;

import com.palantir.transforms.lang.java.api.Pipeline;
import com.palantir.transforms.lang.java.api.PipelineDefiner;

public final class MyPipelineDefiner implements PipelineDefiner {

    @Override
    public void define(Pipeline pipeline) {
        // Every transform in this package with @Input / @Output annotations is registered.
        pipeline.autoBindFromPackage("myproject.datasets");
    }
}
"""

JAVA_HIGH_LEVEL = """package myproject.datasets;

import com.palantir.transforms.lang.java.api.Compute;
import com.palantir.transforms.lang.java.api.Input;
import com.palantir.transforms.lang.java.api.Output;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;

/**
 * This is an example high-level Transform intended for automatic registration.
 * Un-comment it, then replace the paths with your input dataset and the output dataset to create.
 */
public final class HighLevelAutoTransform {

//    @Compute
//    // Replace this with the full path to your output dataset.
//    @Output("/path/to/output/dataset")
//    // Replace this with the full path to your input dataset.
//    public Dataset<Row> myComputeFunction(@Input("/path/to/input/dataset") Dataset<Row> myInput) {
//        // The compute function for a high-level Transform returns an output of type "Dataset<Row>".
//        return myInput.limit(10);
//    }
}
"""

JAVA_LOW_LEVEL = """package myproject.datasets;

import com.palantir.transforms.lang.java.api.Compute;
import com.palantir.transforms.lang.java.api.FoundryInput;
import com.palantir.transforms.lang.java.api.FoundryOutput;
import com.palantir.transforms.lang.java.api.Input;
import com.palantir.transforms.lang.java.api.Output;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;

/**
 * This is an example low-level Transform intended for automatic registration.
 * Un-comment it, then replace the paths.
 */
public final class LowLevelAutoTransform {

//    @Compute
//    public void myComputeFunction(
//            @Input("/path/to/input/dataset") FoundryInput myInput,
//            @Output("/path/to/output/dataset") FoundryOutput myOutput) {
//        Dataset<Row> limited = myInput.asDataFrame().read().limit(10);
//        // The compute function for a low-level Transform writes to the output dataset(s).
//        myOutput.getDataFrameWriter(limited).write();
//    }
}
"""

JAVA_TEST = """package myproject;

import static org.apache.spark.sql.functions.col;
import static org.assertj.core.api.Assertions.assertThat;

import com.palantir.transforms.lang.java.testing.api.SparkSessionExtension;
import java.util.Arrays;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;
import org.apache.spark.sql.RowFactory;
import org.apache.spark.sql.types.DataTypes;
import org.apache.spark.sql.types.StructType;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;

public class ExampleTest {
    @RegisterExtension
    public static SparkSessionExtension sparkSession = new SparkSessionExtension();

    @Test
    public void filtersRows() {
        StructType schema = new StructType().add("Sex", DataTypes.StringType).add("Age", DataTypes.IntegerType);
        Dataset<Row> df = sparkSession.get().createDataFrame(Arrays.asList(RowFactory.create("female", 30), RowFactory.create("male", 40)), schema);
        assertThat(df.filter(col("Sex").equalTo("female")).count()).isEqualTo(1L);
    }
}
"""

SERVICES = "myproject.MyPipelineDefiner\n"

UDF_README = """# {name}

Map UDF Definition/Implementation: user-defined functions in Java for Pipeline Builder.

1. Define a UDF in `udf-definitions-map-udf-definition/src/main/resources/udfs/definitions/<Name>.yml` (name, input and
   output schemas, arguments; `type: FLAT_MAP_UDF` for a flat map).
2. Run **generateUdfResources** (Java tasks) to generate the typed classes: `com.palantir.foundry.<name>` holds the
   configuration, the input and output rows, the UDF and factory interfaces and the adapters.
3. Implement `<Name>MapUdfFactoryImpl` and `<Name>MapUdfImpl` in `src/main/java/myproject`.
4. Add examples in `src/test/java/examples/registry`: they run as tests and show in Pipeline Builder.
5. Run **generateEddieLockfile**, commit, tag a version (`0.0.1`) and wait for the checks to pass. Then in Pipeline
   Builder: Reusables → User-defined functions → Import UDF.
"""

MULTIPLY_YML = """name: Multiply
description: Multiplies each row's value by a number.
inputSchema:
  name: Multiplicand
  description: A key and the value to multiply.
  fields:
    - name: key
      nullable: false
      type:
        type: string
        string: {}
    - name: value
      nullable: true
      type:
        type: double
        double: {}
outputSchema:
  name: Product
  description: The key and the multiplied value.
  fields:
    - name: key
      nullable: false
      type:
        type: string
        string: {}
    - name: value
      nullable: true
      type:
        type: double
        double: {}
arguments:
  multiplier:
    required: true
    description: The number each value is multiplied by.
    type:
      type: double
      double: {}
"""

MULTIPLY_FACTORY = """package myproject;

import com.google.auto.service.AutoService;
import com.palantir.foundry.multiply.MultiplyMapUdf;
import com.palantir.foundry.multiply.MultiplyMapUdfAdapter;
import com.palantir.foundry.multiply.MultiplyMapUdfFactory;
import com.palantir.foundry.multiply.config.MultiplyConfiguration;
import com.palantir.foundry.udf.api.FoundryRowMapUdf;
import com.palantir.foundry.udf.api.FoundryRowMapUdfFactory;

/**
 * Factory for creating the "Multiply" UDF.
 */
@AutoService(FoundryRowMapUdfFactory.class)
public final class MultiplyMapUdfFactoryImpl implements MultiplyMapUdfFactory {

    /**
     * Service-loading at runtime requires a public, no-arg constructor.
     */
    public MultiplyMapUdfFactoryImpl() {}

    @Override
    public FoundryRowMapUdf create(FoundryRowMapUdfFactory.Arguments<MultiplyConfiguration> args) {
        MultiplyMapUdf impl = new MultiplyMapUdfImpl(args.config());
        return new MultiplyMapUdfAdapter(impl);
    }
}
"""

MULTIPLY_IMPL = """package myproject;

import com.palantir.foundry.multiply.MultiplyMapUdf;
import com.palantir.foundry.multiply.config.MultiplyConfiguration;
import com.palantir.foundry.multiply.input.Multiplicand;
import com.palantir.foundry.multiply.output.Product;
import com.palantir.foundry.udf.api.FoundryRowMapUdf;

/**
 * Implementation for the "Multiply" UDF logic: called once for every row.
 */
public final class MultiplyMapUdfImpl implements MultiplyMapUdf {

    private final MultiplyConfiguration config;

    public MultiplyMapUdfImpl(MultiplyConfiguration config) {
        this.config = config;
    }

    @Override
    public Product map(FoundryRowMapUdf.Context ctx, Multiplicand input) {
        return Product.create(ctx.getRowBuilderFactory())
                .key(input.key())
                .value(input.value() == null ? null : input.value() * config.multiplier());
    }
}
"""

MULTIPLY_EXAMPLES = """package examples.registry;

import com.palantir.foundry.multiply.config.MultiplyConfiguration;
import com.palantir.foundry.multiply.input.SettableMultiplicand;
import com.palantir.foundry.multiply.output.Product;
import com.palantir.foundry.udf.examples.ExampleCategory;
import com.palantir.foundry.udf.examples.ExampleId;
import com.palantir.foundry.udf.examples.ExampleVisibility;
import com.palantir.foundry.udf.examples.Examples;
import com.palantir.foundry.udf.examples.UdfExample;
import java.util.List;

public final class MultiplyExamples implements Examples<SettableMultiplicand, Product, MultiplyConfiguration> {

    @Override
    public String name() {
        // must be the UDF's name
        return "Multiply";
    }

    @Override
    public List<UdfExample<SettableMultiplicand, Product, MultiplyConfiguration>> examples() {
        return List.of(UdfExample.<SettableMultiplicand, Product, MultiplyConfiguration>builder()
                // A unique ID for this example
                .id(ExampleId.of("baseCase"))
                // Optional: A description of what this example represents
                .description("Multiply values by 2.")
                // Whether this example should have PROMINENT or DEFAULT visibility in Pipeline Builder
                .visibility(ExampleVisibility.DEFAULT)
                // The case that this example illustrates (base case, null case, edge case)
                .category(ExampleCategory.BASE)
                // The arguments to pass to the UDF that this example illustrates
                .configuration(MultiplyConfiguration.builder().multiplier(2.0d).build())
                // The example input rows to the UDF
                .input(
                        SettableMultiplicand.create(ctx().getRowBuilderFactory()).key("key").value(1.5d),
                        SettableMultiplicand.create(ctx().getRowBuilderFactory()).key("key").value(3.0d))
                // The rows the UDF must output for them
                .output(
                        Product.create(ctx().getRowBuilderFactory()).key("key").value(3.0d),
                        Product.create(ctx().getRowBuilderFactory()).key("key").value(6.0d))
                .build());
    }
}
"""


def java_files(name: str, settings: str) -> dict[str, str]:
    p = "transforms-java/src"
    return {
        "README.md": JAVA_README.format(name=name),
        "repoSettings.json": settings,
        "transforms-java/build.gradle": JAVA_BUILD_GRADLE,
        f"{p}/main/java/myproject/MyPipelineDefiner.java": JAVA_DEFINER,
        f"{p}/main/resources/META-INF/services/com.palantir.transforms.lang.java.api.PipelineDefiner": SERVICES,
        f"{p}/main/java/myproject/datasets/HighLevelAutoTransform.java": JAVA_HIGH_LEVEL,
        f"{p}/main/java/myproject/datasets/LowLevelAutoTransform.java": JAVA_LOW_LEVEL,
        f"{p}/test/java/myproject/ExampleTest.java": JAVA_TEST,
    }


def udf_files(name: str, settings: str) -> dict[str, str]:
    p = "udf-definitions-map-udf-definition/src"
    return {
        "README.md": UDF_README.format(name=name),
        "repoSettings.json": settings,
        f"{p}/main/resources/udfs/definitions/Multiply.yml": MULTIPLY_YML,
        f"{p}/main/java/myproject/MultiplyMapUdfFactoryImpl.java": MULTIPLY_FACTORY,
        f"{p}/main/java/myproject/MultiplyMapUdfImpl.java": MULTIPLY_IMPL,
        f"{p}/test/java/examples/registry/MultiplyExamples.java": MULTIPLY_EXAMPLES,
    }


KEYED_README = """# {name}

Keyed Process UDF: a stateful Java user-defined function for streaming pipelines in Pipeline Builder (like Flink's
KeyedProcessFunction). Records are partitioned by `keyColumns`; each call sees only its key's state and timers.

1. The definition `udf-definitions-keyed-process/src/main/resources/udfs/definitions/SensorWindow.yml` sets
   `type: KEYED_PROCESS_UDF`, `keyColumns`, an optional `eventTimeColumn` and `stateSchema` (the state kept per key).
2. Run **generateUdfResources**: `com.palantir.foundry.sensorwindow` gets the typed input, output and state rows, the
   `SensorWindowKeyedProcessUdf` interface (processElement, onTimer) and its factory and adapter.
3. `SensorWindowKeyedProcessUdfImpl` counts readings per sensor in one-minute event-time windows: the first reading of
   a window registers an event-time timer at the window's end - 1 ms; when the watermark passes it, onTimer emits the
   window's count and average and clears the state.
4. Timers: `ctx.timerService().registerEventTimeTimer(...)` fires once the watermark (event time - 1 ms of the latest
   record) reaches it; `registerProcessingTimeTimer(...)` once the job's clock does.
5. In a streaming pipeline, the state and timers are kept in the job's checkpoint between micro-batches; a batch build
   starts from empty state and fires every event-time timer at the end of its input. A replay resets the state.
6. Run **generateEddieLockfile**, commit, tag a version (`0.0.1`), wait for the checks, then import it in Pipeline
   Builder: Reusables → User-defined functions → Import UDF.
"""

SENSOR_WINDOW_YML = """name: SensorWindow
description: Count and average of each sensor's readings per one-minute event-time window.
type: KEYED_PROCESS_UDF
keyColumns:
  - sensor_id
eventTimeColumn: ts
inputSchema:
  name: Reading
  fields:
    - name: sensor_id
      nullable: false
      type:
        type: string
        string: {}
    - name: ts
      nullable: false
      type:
        type: timestamp
        timestamp: {}
    - name: value
      nullable: true
      type:
        type: double
        double: {}
outputSchema:
  name: WindowSummary
  fields:
    - name: sensor_id
      nullable: false
      type:
        type: string
        string: {}
    - name: window_start
      nullable: false
      type:
        type: timestamp
        timestamp: {}
    - name: readings
      nullable: false
      type:
        type: long
        long: {}
    - name: average
      nullable: true
      type:
        type: double
        double: {}
stateSchema:
  name: WindowState
  fields:
    - name: window_start
      type:
        type: timestamp
        timestamp: {}
    - name: readings
      type:
        type: long
        long: {}
    - name: total
      type:
        type: double
        double: {}
arguments:
  window_seconds:
    required: false
    description: Window length in seconds (default 60).
    type:
      type: long
      long: {}
"""

SENSOR_WINDOW_FACTORY = """package myproject;

import com.google.auto.service.AutoService;
import com.palantir.foundry.sensorwindow.SensorWindowKeyedProcessUdfAdapter;
import com.palantir.foundry.sensorwindow.SensorWindowKeyedProcessUdfFactory;
import com.palantir.foundry.sensorwindow.config.SensorWindowConfiguration;
import com.palantir.foundry.udf.api.keyed.FoundryKeyedProcessUdf;
import com.palantir.foundry.udf.api.keyed.FoundryKeyedProcessUdfFactory;

/**
 * Factory for creating the "SensorWindow" UDF.
 */
@AutoService(FoundryKeyedProcessUdfFactory.class)
public final class SensorWindowKeyedProcessUdfFactoryImpl implements SensorWindowKeyedProcessUdfFactory {

    /**
     * Service-loading at runtime requires a public, no-arg constructor.
     */
    public SensorWindowKeyedProcessUdfFactoryImpl() {}

    @Override
    public FoundryKeyedProcessUdf create(FoundryKeyedProcessUdfFactory.Arguments<SensorWindowConfiguration> args) {
        return new SensorWindowKeyedProcessUdfAdapter(new SensorWindowKeyedProcessUdfImpl(args.config()));
    }
}
"""

SENSOR_WINDOW_IMPL = """package myproject;

import com.palantir.foundry.sensorwindow.SensorWindowKeyedProcessUdf;
import com.palantir.foundry.sensorwindow.config.SensorWindowConfiguration;
import com.palantir.foundry.sensorwindow.input.Reading;
import com.palantir.foundry.sensorwindow.output.WindowSummary;
import com.palantir.foundry.sensorwindow.state.WindowState;
import com.palantir.foundry.udf.api.flatmap.Collector;
import java.time.Instant;

/**
 * Tumbling event-time windows per sensor: state holds the open window; its timer emits the summary.
 */
public final class SensorWindowKeyedProcessUdfImpl implements SensorWindowKeyedProcessUdf {

    private final long windowMillis;

    public SensorWindowKeyedProcessUdfImpl(SensorWindowConfiguration config) {
        this.windowMillis = (config.windowSeconds() == null ? 60 : config.windowSeconds()) * 1000;
    }

    @Override
    public void processElement(Context ctx, Reading input, Collector<WindowSummary> out) {
        long t = input.ts().toEpochMilli();
        Instant start = Instant.ofEpochMilli(t - Math.floorMod(t, windowMillis));
        WindowState state = ctx.getState();
        if (state == null || !state.windowStart().equals(start)) {
            if (state != null && state.windowStart().isAfter(start)) {
                return; // late: its window was already emitted
            }
            state = WindowState.create(ctx.getRowBuilderFactory()).windowStart(start).readings(0L).total(0.0d);
            // fires once the watermark passes the window's last millisecond
            ctx.timerService().registerEventTimeTimer(start.plusMillis(windowMillis - 1));
        }
        state.readings(state.readings() + 1).total(state.total() + (input.value() == null ? 0.0d : input.value()));
        ctx.updateState(state);
    }

    @Override
    public void onTimer(OnTimerContext ctx, Collector<WindowSummary> out) {
        WindowState state = ctx.getState();
        if (state == null) {
            return;
        }
        out.collect(WindowSummary.create(ctx.getRowBuilderFactory())
                .sensorId((String) ctx.currentKey().get(0))
                .windowStart(state.windowStart())
                .readings(state.readings())
                .average(state.readings() == 0 ? null : state.total() / state.readings()));
        ctx.clearState();
    }
}
"""

SENSOR_WINDOW_EXAMPLES = """package examples.registry;

import com.palantir.foundry.sensorwindow.config.SensorWindowConfiguration;
import com.palantir.foundry.sensorwindow.input.SettableReading;
import com.palantir.foundry.sensorwindow.output.WindowSummary;
import com.palantir.foundry.udf.examples.ExampleCategory;
import com.palantir.foundry.udf.examples.ExampleId;
import com.palantir.foundry.udf.examples.ExampleVisibility;
import com.palantir.foundry.udf.examples.Examples;
import com.palantir.foundry.udf.examples.UdfExample;
import java.time.Instant;
import java.util.List;

public final class SensorWindowExamples implements Examples<SettableReading, WindowSummary, SensorWindowConfiguration> {

    @Override
    public String name() {
        return "SensorWindow";
    }

    private SettableReading reading(String sensor, String ts, double value) {
        return SettableReading.create(ctx().getRowBuilderFactory()).sensorId(sensor).ts(Instant.parse(ts)).value(value);
    }

    @Override
    public List<UdfExample<SettableReading, WindowSummary, SensorWindowConfiguration>> examples() {
        // examples run as a batch: every window is emitted at the end of the input
        return List.of(UdfExample.<SettableReading, WindowSummary, SensorWindowConfiguration>builder()
                .id(ExampleId.of("twoWindows"))
                .description("Readings of two sensors over two minutes.")
                .visibility(ExampleVisibility.PROMINENT)
                .category(ExampleCategory.BASE)
                .configuration(SensorWindowConfiguration.builder().build())
                .input(
                        reading("a", "2026-01-01T00:00:10Z", 1.0d),
                        reading("a", "2026-01-01T00:00:40Z", 3.0d),
                        reading("b", "2026-01-01T00:00:50Z", 5.0d),
                        reading("a", "2026-01-01T00:01:05Z", 4.0d))
                .output(
                        WindowSummary.create(ctx().getRowBuilderFactory()).sensorId("a").windowStart(Instant.parse("2026-01-01T00:00:00Z")).readings(2L).average(2.0d),
                        WindowSummary.create(ctx().getRowBuilderFactory()).sensorId("b").windowStart(Instant.parse("2026-01-01T00:00:00Z")).readings(1L).average(5.0d),
                        WindowSummary.create(ctx().getRowBuilderFactory()).sensorId("a").windowStart(Instant.parse("2026-01-01T00:01:00Z")).readings(1L).average(4.0d))
                .build());
    }
}
"""


def keyed_udf_files(name: str, settings: str) -> dict[str, str]:
    p = "udf-definitions-keyed-process/src"
    return {
        "README.md": KEYED_README.format(name=name),
        "repoSettings.json": settings,
        f"{p}/main/resources/udfs/definitions/SensorWindow.yml": SENSOR_WINDOW_YML,
        f"{p}/main/java/myproject/SensorWindowKeyedProcessUdfFactoryImpl.java": SENSOR_WINDOW_FACTORY,
        f"{p}/main/java/myproject/SensorWindowKeyedProcessUdfImpl.java": SENSOR_WINDOW_IMPL,
        f"{p}/test/java/examples/registry/SensorWindowExamples.java": SENSOR_WINDOW_EXAMPLES,
    }


EXCEL_README = """# {name}

Java transforms that parse Microsoft Excel files with Palantir's `transforms-excel-parser` (Apache POI with sensible
defaults): xls, xlt, xltm, xltx, xlsx and xlsm (not xlsb).

- `transforms-excel-parser-bundle` is a backing repository (Settings -> Artifacts) and
  `transforms-java/build.gradle` depends on `com.palantir.transforms.excel-parser:transforms-excel-parser:<version>`.
- `SimpleTabularExcel` reads every file of a folder (a dataset of files) as one table whose header is on the second row;
  files with partially overlapping columns are combined, and failures go to the error output.
- `FormStyleExcel` reads form-style sheets: fields at cells, each checked against the label to its left.

Point the `@Input` paths at your folders of Excel files, then Preview or Build. Parsing runs in memory: large workbooks
need generous memory (on Foundry: EXECUTOR_MEMORY_LARGE with EXECUTOR_CORES_EXTRA_SMALL).
"""

EXCEL_BUILD_GRADLE = """apply plugin: 'com.palantir.transforms.lang.java'
apply plugin: 'com.palantir.transforms.lang.java-defaults'

dependencies {
    compile 'com.palantir.transforms.excel-parser:transforms-excel-parser:1.155.0'
}
"""

EXCEL_SIMPLE = 'package myproject.datasets;\n\nimport com.palantir.transforms.excel.ParseResult;\nimport com.palantir.transforms.excel.Parser;\nimport com.palantir.transforms.excel.TransformsExcelParser;\nimport com.palantir.transforms.excel.table.SimpleHeaderExtractor;\nimport com.palantir.transforms.excel.table.TableParser;\nimport com.palantir.transforms.lang.java.api.Compute;\nimport com.palantir.transforms.lang.java.api.FoundryInput;\nimport com.palantir.transforms.lang.java.api.FoundryOutput;\nimport com.palantir.transforms.lang.java.api.Input;\nimport com.palantir.transforms.lang.java.api.Output;\nimport java.util.Optional;\nimport org.apache.spark.sql.Dataset;\nimport org.apache.spark.sql.Row;\n\npublic final class SimpleTabularExcel {\n    @Compute\n    public void myComputeFunction(\n            @Input("/My Project/Excel files") FoundryInput myInput,\n            @Output("parsed_excel") FoundryOutput myOutput,\n            @Output("parsed_excel_errors") FoundryOutput errorOutput) {\n        Parser tableParser = TableParser.builder()\n                .headerExtractor(SimpleHeaderExtractor.builder().rowsToSkip(1).build())\n                .build();\n        TransformsExcelParser transformsParser = TransformsExcelParser.of(tableParser);\n        ParseResult result = transformsParser.parse(myInput.asFiles().getFileSystem().filesAsDataset());\n        Optional<Dataset<Row>> maybeDf = result.singleResult();\n        maybeDf.ifPresent(df -> myOutput.getDataFrameWriter(df).write());\n        errorOutput.getDataFrameWriter(result.errorDataframe()).write();\n    }\n}\n'

EXCEL_FORMS = 'package myproject.datasets;\n\nimport com.palantir.transforms.excel.TransformsExcelParser;\nimport com.palantir.transforms.excel.ParseResult;\nimport com.palantir.transforms.excel.Parser;\nimport com.palantir.transforms.excel.form.FieldSpec;\nimport com.palantir.transforms.excel.form.FormParser;\nimport com.palantir.transforms.excel.form.Location;\nimport com.palantir.transforms.excel.form.cellvalue.AdjacentCellAssertion;\nimport com.palantir.transforms.excel.form.cellvalue.CellValue;\nimport com.palantir.transforms.excel.functions.RegexSubstringMatchingSheetSelector;\nimport com.palantir.transforms.lang.java.api.Compute;\nimport com.palantir.transforms.lang.java.api.FoundryInput;\nimport com.palantir.transforms.lang.java.api.FoundryOutput;\nimport com.palantir.transforms.lang.java.api.Input;\nimport com.palantir.transforms.lang.java.api.Output;\n\npublic final class FormStyleExcel {\n    private static final String FORM_A_KEY = "FORM_A";\n    private static final String FORM_B_KEY = "FORM_B";\n\n    @Compute\n    public void myComputeFunction(\n            @Input("/My Project/Excel forms") FoundryInput myInput,\n            @Output("form_a") FoundryOutput formAOutput,\n            @Output("form_b") FoundryOutput formBOutput,\n            @Output("form_errors") FoundryOutput errorOutput) {\n        Parser formAParser = FormParser.builder()\n                .sheetSelector(new RegexSubstringMatchingSheetSelector("Form_A"))\n                .addFieldSpecs(createFieldSpec("form_a_field_1", "B1"))\n                .addFieldSpecs(createFieldSpec("form_a_field_2", "B2"))\n                .build();\n        Parser formBParser = FormParser.builder()\n                .sheetSelector(new RegexSubstringMatchingSheetSelector("Form_B"))\n                .addFieldSpecs(createFieldSpec("form_b_field_1", "B1"))\n                .addFieldSpecs(createFieldSpec("form_b_field_2", "B2"))\n                .build();\n        TransformsExcelParser transformsParser = TransformsExcelParser.builder()\n                .putKeyToParser(FORM_A_KEY, formAParser)\n                .putKeyToParser(FORM_B_KEY, formBParser)\n                .build();\n        ParseResult result = transformsParser.parse(myInput.asFiles().getFileSystem().filesAsDataset());\n        result.dataframeForKey(FORM_A_KEY).ifPresent(df -> formAOutput.getDataFrameWriter(df).write());\n        result.dataframeForKey(FORM_B_KEY).ifPresent(df -> formBOutput.getDataFrameWriter(df).write());\n        errorOutput.getDataFrameWriter(result.errorDataframe()).write();\n    }\n\n    private static FieldSpec createFieldSpec(String fieldName, String cellLocation) {\n        return FieldSpec.of(fieldName, CellValue.builder()\n                .addAssertions(AdjacentCellAssertion.left(1, fieldName))\n                .location(Location.of(cellLocation))\n                .build());\n    }\n}\n'


def excel_files(name: str, settings: str) -> dict[str, str]:
    p = "transforms-java/src"
    return {
        "README.md": EXCEL_README.format(name=name),
        "repoSettings.json": settings,
        "transforms-java/build.gradle": EXCEL_BUILD_GRADLE,
        f"{p}/main/java/myproject/MyPipelineDefiner.java": JAVA_DEFINER,
        f"{p}/main/resources/META-INF/services/com.palantir.transforms.lang.java.api.PipelineDefiner": SERVICES,
        f"{p}/main/java/myproject/datasets/SimpleTabularExcel.java": EXCEL_SIMPLE,
        f"{p}/main/java/myproject/datasets/FormStyleExcel.java": EXCEL_FORMS,
    }
