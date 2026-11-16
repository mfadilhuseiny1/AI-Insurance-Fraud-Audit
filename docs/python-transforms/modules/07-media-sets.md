# Media sets in Python transforms

Remaining work for Python transforms — module `07-media-sets`. Source: `23 - Python.md`.

## What is missing and how to finish it

**Mostly done** (`api/code_media.py`): listing, get/put, fast copy, put_dataset_files, write modes, media
references, metadata, `transform()` image / document / spreadsheet / email / audio-video (ffmpeg) operations, OCR
(RapidOCR), `write()`.

**Done since:** `render_dicom_layer()` (pydicom), media set schemas, formats and transaction policies
(`api/media_sets.py`: a transactional output defaults to `replace`, a transactionless one only `modify`),
`deduplicate_by_path=False`, `register_media_item` (virtual sets), `put_dataset_files_and_get_dataframe_of_uploads`.

**Done since (2026-10-09):** `tile()` for GeoTIFFs (Pillow + pyproj; tested 9 checks), `extractLayoutAwareTextV2`
blocks with types / bounding boxes / confidence in TEXT, MARKDOWN and HTML and ELECTRONIC / SCAN / AUTO modes (8),
`encrypt()` / `decrypt()` with Cipher licenses (`api/cipher.py`, Control Panel → Cipher licenses; 8), `transcribe()` (Whisper tiny / base; 3) and
`generate_image_embeddings()` (CLIP ViT-B/32; 2).

Table blocks too: rows of cells whose columns line up become `table` blocks with their `rows` (TEXT: tab separated,
MARKDOWN: a pipe table, HTML: `<table>`), from the text layer or OCR boxes (6 checks).

**Not done:** NITF tiles (GDAL); SigLIP 2 weights are not shipped (CLIP is used unless they are installed);
tables need aligned columns (no ruling-line or spanning-cell detection) and OCR headings are told apart by box height
only; the "Create media set" lightbulb dialog in the editor
(create it in the Media sets app or Files instead); media transforms run in preview (doc: not supported).

**To finish:** add a media set item kind (folder + schema + policy) in Drive; `pydicom`, `faster-whisper`,
`open_clip` (SigLIP) where acceptable; GDAL for tiles; layout blocks via pypdfium2 text boxes + RapidOCR boxes.

Where the code lives: `api/code_pyapi.py` (transforms.api), `api/code_runner.py` (runs a transform in a subprocess),
`api/code_repos.py` (builds, checks, Task Runner, libraries), `api/code_env.py` (meta.yaml), `api/code_media.py`
(media sets), `api/code_expectations.py` (data expectations), `web/src/components/code/PythonPanels.tsx` and
`web/src/app/code-repositories/[id]/page.tsx` (UI). Test with `docs/python-transforms/runner_harness.py` (writes repo files + spec.json, runs `code_runner.py`)
and live calls to `/api/code-repos/*` (sign-in required: an API token, or `BLUESANDAI_AUTH=off`).

## Source documentation (verbatim)

Sections: [media-sets](https://www.palantir.com/docs/foundry/transforms-python/media-sets/), [media-set-transforms-api](https://www.palantir.com/docs/foundry/transforms-python/media-set-transforms-api/)

---

### Use media sets with Python transforms

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/media-sets/

#### Use media sets with Python transforms

You can use [media sets](https://www.palantir.com/docs/foundry/data-integration/media-sets/) in Python transforms for PDF text extraction, optical character recognition (OCR), image tiling, metadata parsing, and more. The following sections explain how to set up media sets in your Python repository and how to read to and write from media sets with Python transforms.

Here is  a step-by-step example of how to [create a media set batch pipeline with Code Repositories](https://www.palantir.com/docs/foundry/building-pipelines/create-batch-pipeline-cr-media-sets/).

You can also learn how to [write incremental transforms with media sets](https://www.palantir.com/docs/foundry/transforms-python-spark/incremental-media-sets/).

> [!NOTE]
>
> Media transformations are currently not supported in [Code Repository's Preview](https://www.palantir.com/docs/foundry/code-repositories/preview-transforms/) functionality. Any transforms utilizing media sets can be built but not previewed.

##### Import the transforms-media library into your repository

To use decorators specific to media sets, you first need to import the `transforms-media` library into your repository. You can do this by navigating to the **Libraries** file drawer on the left side of the Code Repositories interface. Search for `transforms-media`, then install the library.

##### Add a dependency on `transforms-media` in your code repository.

You must use the [`@transform`](https://www.palantir.com/docs/foundry/transforms-python/transforms/#define-pyspark-transforms) decorator when working with media sets. Media set inputs and outputs can be passed in using `transforms.mediasets.MediaSetInput` and `transforms.mediasets.MediaSetOutput` specifications. During a build, these specifications are resolved into `transforms.mediasets.MediaSetInputParam` and `transforms.mediasets.MediaSetOutputParam` objects, respectively. These `MediaSetInputParam` and `MediaSetOutputParam` objects provide access to the media set within the compute function. Any number of media set inputs or outputs can be used in combination with any other valid transform inputs and outputs (such as tabular datasets). For example:

```python
from transforms.api import transform
from transforms.mediasets import MediaSetInput, MediaSetOutput


@transform.spark.using(
    images=MediaSetInput('/examples/images'),
    output_images=MediaSetOutput('/examples/output_images')
)
def translate_images(images, output_images):
    ...
```

##### Read from media sets

You can access individual media items either by the file path or RID:

```python
from transforms.api import transform
from transforms.mediasets import MediaSetInput, MediaSetOutput


@transform.spark.using(
    images=MediaSetInput('/examples/images'),
    output_images=MediaSetOutput('/examples/output_images')
)
def translate_images(images, output_images):
    image1 = images.get_media_item_by_path("image1")
    image2 = images.get_media_item("ri.mio.main.media-item.123")
    ...
```

However, you will likely want to transform all the items in your media set. To do this, you must first pull the items into a dataframe using a *listing* method. In the example below, we list all items in the input media set and write the resulting dataframe to a tabular output:

```python
from transforms.api import transform, Output
from transforms.mediasets import MediaSetInput


@transform.spark.using(
    images=MediaSetInput('/examples/images'),
    listing_output=Output('/examples/listed_images')
)
def translate_images(ctx, images, listing_output):
    media_items_listing = images.list_media_items_by_path_with_media_reference(ctx)

    # You can perform regular PySpark transformations on media_items_listing

    column_typeclasses = {'mediaReference': [{'kind': 'reference', 'name': 'media_reference'}]}
    listing_output.write_dataframe(media_items_listing, column_typeclasses=column_typeclasses)
```

If multiple items in the media set are at a particular path, only the most recent will be included in the listing. The listing will have the following schema:

```
+--------------------------+-----------+-------------------+
|        mediaItemRid      |    path   |  mediaReference   |
+--------------------------+-----------+-------------------+
| ri.mio.main.media-item.1 | item1.jpg |  {{reference1}}   |
| ri.mio.main.media-item.2 | item2.jpg |  {{reference2}}   |
| ri.mio.main.media-item.3 | item3.jpg |  {{reference3}}   |
+--------------------------+-----------+-------------------+
```

The above example only shows the top three rows of the listing.

Setting the typeclass of the `mediaReference` column allows the column to be read as a [media reference](https://www.palantir.com/docs/foundry/media-sets-advanced-formats/media-overview/#media-references).

Calls to `get_media_item()`, `get_media_item_by_path()`, and so on return a Python file-like stream object. All options accepted by [`io.open()` ↗](https://docs.python.org/3/library/io.html#io.open) are also supported. Items are read as streams, meaning that random access is not supported.

You can also return metadata about individual media items without downloading the full item. The metadata will include information such as the dimensions for images, length for audio, and more. For a full reference of available metadata, see the appendix below. The example below adds a column to the media item listing with the metadata for each image.

```python
from transforms.api import transform, Output
from transforms.mediasets import MediaSetInput
from pyspark.sql import functions as F
from pyspark.sql.types import StringType
from conjure_python_client import ConjureEncoder


@transform.spark.using(
    images=MediaSetInput('/examples/images'),
    listing_output_with_metadata=Output('/examples/listed_images_with_metadata')
)
def translate_images(ctx, images, listing_output_with_metadata):

    def get_metadata(media_item_rid):
        metadata = images.get_media_item_metadata(media_item_rid)
        return ConjureEncoder().default(metadata)

    metadata_udf = F.udf(get_metadata, StringType())

    media_items_listing = images.list_media_items_by_path_with_media_reference(ctx)
    listing_with_metadata = media_items_listing.withColumn('metadata', metadata_udf(F.col('mediaItemRid')))
    column_typeclasses = {'mediaReference': [{'kind': 'reference', 'name': 'media_reference'}]}
    listing_output_with_metadata.write_dataframe(listing_with_metadata, column_typeclasses=column_typeclasses)
```

Media sets support a certain number of built-in transformations out of the box. See the appendix below for the API and list of supported transformations. Calls to these transformations will also return a Python file-like stream object. To use these built-in transformations, call the appropriate method on the media set input. For example:

```python
@transform.spark.using(
    images=MediaSetInput('/examples/images'),
    image_text_output=Output('/examples/listed_images_with_text')
)
def translate_images(ctx, images, image_text_output):

    def get_ocr_on_image(media_item_rid):
        return images.transform_image_to_text_ocr_output_text(media_item_rid).read().decode('utf-8')

    ocr_on_image_udf = F.udf(get_ocr_on_image, StringType())

    media_items_listing = images.list_media_items_by_path_with_media_reference(ctx)
    listing_with_ocr = media_items_listing.withColumn('text', ocr_on_image_udf(F.col('mediaItemRid')))
    column_typeclasses = {'mediaReference': [{'kind': 'reference', 'name': 'media_reference'}]}
    image_text_output.write_dataframe(listing_with_ocr, column_typeclasses=column_typeclasses)
```

##### Create a media set

In addition to creating a media set within a project or folder using the media set creation dialog, you can also create a media set directly within Code Repositories to be used as an output of your Python transform.

First, choose an output location and a name for the new media set in the `MediaSetOutput` specification.

Select the path you have just defined, which at this point should be underlined in red; on hover, you should see an error message indicating the media set does not exist.

From the lightbulb icon on the left side of the line, select **Create media set**.

<img src="assets/foundry/transforms-python/media-set-output-lightbulb.png" alt="Create media set output prompt" width="800">

Go through the dialog steps to choose the desired [media set schema](https://www.palantir.com/docs/foundry/media-sets-advanced-formats/media-overview/#supported-media-set-schemas) and complete any other required configuration on your new media set.

<img src="assets/foundry/transforms-python/media-set-dialog.png" alt="Create media set dialog" width="800">

After selecting **Create**, the `MediaSetOutput` specification will be populated with the details you have provided. These annotation fields define how the media set will be created.

<img src="assets/foundry/transforms-python/media-set-output-annotations.png" alt="Create media set annotations" width="800">

The new media set will be created after the Python transform has been built for the first time, after which the annotation fields should not be edited.

##### Write to media sets

Media sets can be used as outputs to transformations by using the `MediaSetOutput` specification.

To upload an item, call the `put_media_item()` endpoint on the output media set. This endpoint accepts any file-like object and a path which will be used to identify the item in the output media set. The following is a basic example:

```python
from transforms.api import transform
from transforms.mediasets import MediaSetInput, MediaSetOutput


@transform.spark.using(
    images=MediaSetInput('/examples/images'),
    output_images=MediaSetOutput('/examples/output_images')
)
def upload_images(images, output_images):
    with images.get_media_item_by_path("image1.jpg") as input_image:
        output_images.put_media_item(input_image, "copied_image1.jpg")
```

When copying items from one media set to another, you can use the `fast_copy_media_item()` method on the output. This is a faster and more efficient option than downloading and re-uploading the media item:

```python
@transform.spark.using(
    images=MediaSetInput('/examples/images'),
    output_images=MediaSetOutput('/examples/output_images')
)
def upload_images(images, output_images):
    origin_media_item_rid = images.get_media_item_rid_by_path("image1.jpg").item
    output_images.fast_copy_media_item(images, origin_media_item_rid, "fast_copied_image1.jpg")
```

Items can be uploaded to media sets in user-defined functions (UDFs) for higher parallelism. In the example below, we transform the PDFs in the input media set into JPEGs using the built-in PDF to JPEG transformation and upload those JPEGs to a new output media set. We then write out a tabular dataset containing the media references of those uploaded JPEGs:

```python
from transforms.api import transform, Output
from transforms.mediasets import MediaSetInput, MediaSetOutput
from pyspark.sql import functions as F
from pyspark.sql.types import StringType


@transform.spark.using(
    pdfs=MediaSetInput('/examples/PDFs'),
    output_images=MediaSetOutput('/examples/JPEGs'),
    output_references=Output('/examples/JPEG listing')
)
def upload_images(ctx, pdfs, output_images, output_references):

    def upload_jpg(media_item_rid, path):
        with pdfs.transform_document_to_jpg(media_item_rid, 0) as jpeg:
            response = output_images.put_media_item(jpeg, path)
        return response.media_item_rid

    upload_udf = F.udf(upload_jpg, StringType())

    listed_pdfs = pdfs.list_media_items_by_path(ctx)
    media_reference_template = output_images.media_reference_template()
    uploaded_jpegs = listed_pdfs\
        .withColumn('uploaded_media_item_rid', upload_udf(F.col('mediaItemRid'), F.col('path')))\
        .select('path', 'uploaded_media_item_rid')\
        .withColumn("mediaReference", F.format_string(media_reference_template,
                                                      'uploaded_media_item_rid'))

    column_typeclasses = {'mediaReference': [{'kind': 'reference', 'name': 'media_reference'}]}
    output_references.write_dataframe(uploaded_jpegs, column_typeclasses=column_typeclasses)
```

###### Media set write modes

Media sets can be written to using one of two write modes:

* `modify`: Uploaded items will be added in addition to the existing items in the media set branch.
* `replace`: Uploaded items will fully replace the media set branch.

The default write mode depends on the [transaction policy](https://www.palantir.com/docs/foundry/media-sets-advanced-formats/media-set-settings/#transaction-policies) of the media set. Transactional media sets default to `replace`. Transactionless media sets use the `modify` write mode and this cannot be changed as branches in transactionless media sets cannot be reset to empty.

The write mode of a media set output can be changed dynamically at runtime. This can be helpful in scenarios where the decision to fully replace an output is based on custom criteria in your pipeline.

To change the write mode of a media set, you can use the `.set_write_mode()` method on the media set output. The write mode can be changed at any point up until an item is uploaded to the output. For example:

```python
from transforms.api import transform, Input
from transforms.mediasets import MediaSetOutput

@transform.spark.using(
    input_PNGs=Input('/examples/input_PNGs'),
    output_PNGs=MediaSetOutput('/examples/output_PNGs'),
)
def upload_pngs(input_PNGs, output_PNGs):
    if should_replace(input_PNGs):
        output_PNGs.set_write_mode("replace")
    else:
        output_PNGs.set_write_mode("modify")

    output_PNGs.put_dataset_files(input_PNGs)
```

##### Upload from a filesystem (Catalog) dataset

###### Using `put_dataset_files`

The Python media set SDK has built-in tooling to upload the files from a conventional dataset in the Palantir filesystem (known as the Catalog) into a media set. For example:

```python
from transforms.api import transform, Input
from transforms.mediasets import MediaSetOutput


@transform.spark.using(
    pdfs_dataset=Input('/examples/PDFs'),
    pdfs_media_set=MediaSetOutput('/examples/PDFs media set')
)
def upload_to_media_set(pdfs_dataset, pdfs_media_set):
    pdfs_media_set.put_dataset_files(pdfs_dataset, ignore_items_not_matching_schema=False)
```

This transform will upload all items from the dataset into the media set. If any items do not match the schema of the media set (for example, if there is a JPEG in the dataset), then the build will fail. By setting `ignore_items_not_matching_schema=True` any such mismatches will instead be ignored.

###### Using `put_media_item`

Files can alternatively be uploaded one by one. For example:

```python
from transforms.api import transform, Input, Output, incremental
from transforms.mediasets import MediaSetInput, MediaSetOutput
import os


@transform.spark.using(
    output_media_set=MediaSetOutput("/path/media_set_output", should_snapshot=False),
    input_dataset=Input("/path/dataset_of_raw_files"),
)
def compute(input_dataset, output_media_set):
    all_files = list(input_dataset.filesystem().ls())
    for current_file in all_files:
        with input_dataset.filesystem().open(current_file.path, 'rb') as f:
            filename = os.path.basename(current_file.path)
            output_media_set.put_media_item(f, filename)
```

##### Lightweight support

Media sets can be transformed using [lightweight transforms](https://www.palantir.com/docs/foundry/transforms-python/lightweight-api-evolution/). The API is the same as standard Python transforms, but uses single-node libraries like pandas for dataframe operations when listing media items. The following example shows a lightweight transform that lists all items in the input media set and writes the resulting dataframe to a tabular output:

```python
from transforms.api import transform, Output, lightweight, LightweightOutput
from transforms.mediasets import MediaSetInput, LightweightMediaSetInputParam

@transform.using(
    images=MediaSetInput('/examples/images'),
    listing_output=Output('/examples/listed_images')
)
def translate_images(images: LightweightMediaSetInputParam, listing_output: LightweightOutput):
    media_items_listing = images.list_media_items_by_path_with_media_reference().pandas()

    # You can perform regular pandas transformations on media_items_listing

    listing_output.write_table(media_items_listing)
```

> [!WARNING]
>
> Some operations are not supported in lightweight transforms. In particular, `put_dataset_files` is not supported as it specifically relies on Spark's distributed processing to upload files in parallel.

##### Extract layout-aware content from a document

> [!TIP]
>
> Use the `extractLayoutAwareTextV2` operation to configure the output format (`TEXT`, `MARKDOWN`, or `HTML`), processing mode (`ELECTRONIC`, `SCAN`, or `AUTO`), and page range. Learn more about [document-to-text media transformations](https://www.palantir.com/docs/foundry/document-intelligence/document-to-text/).

When working with media sets, you can use a transform to extract content from a document, such as paragraphs, headers, and tables, along with additional metadata about the layout of this content. This extraction transform can be run on both PDF and image media sets.

Passing the extracted bounding boxes to a vision model may yield better results for particularly complex documents.

For PDF documents, the V2 response is an object with a `pages` array containing an array of blocks for each requested page. Each block includes a type, confidence, ID, bounding box, extracted text, and zero-indexed page number. With `format` set to `TEXT`, the block text is a tagged value such as `{"type": "text", "text": "Extracted content"}`.

The following Python transform extracts one page at a time using OCR and stores the combined V2 response as JSON in the `text` column, with one row per document:

```python
import json

from transforms.api import transform, Output
from transforms.mediasets import MediaSetInput, MediaSetInputParam
from pyspark.sql.functions import udf


@transform.spark.using(
    output=Output('ri.foundry.main.dataset.0-1-2-3-4'),
    media_input=MediaSetInput('/examples/input_pdfs'),
)
def compute(media_input: MediaSetInputParam, output):

    def extract_all_text(media_item_rid):
        metadata = media_input.get_media_item_metadata(media_item_rid)
        pages = metadata.document.pages
        if pages is None:
            return ""

        extracted_pages = []
        for page in range(pages):
            response = media_input.transform_media_item(media_item_rid, str(page), {
                "type": "documentToText",
                "documentToText": {
                    "operation": {
                        "type": "extractLayoutAwareTextV2",
                        "extractLayoutAwareTextV2": {
                            "pageRange": {
                                "startPageInclusive": page,
                                "endPageExclusive": page + 1
                            },
                            "config": {
                                "mode": "SCAN",
                                "format": "TEXT",
                                "languages": [{"type": "language", "language": "ENG"}]
                            }
                        }
                    }
                }
            })
            extracted_pages.extend(response.json()["pages"])
        return json.dumps({"pages": extracted_pages})

    extract_text_udf = udf(extract_all_text)

    result = media_input.dataframe().withColumn("text", extract_text_udf("mediaItemRid"))

    column_typeclasses = {
        "mediaReference": [{"kind": "reference", "name": "media_reference"}]
    }

    output.write_dataframe(result, column_typeclasses=column_typeclasses)
```

We recommend using parallelism for optimal performance if you are running this extraction transform on many documents or on documents with many pages.

For larger documents, you can batch multiple pages per request using `pageRange`. Learn more about [page range configuration](https://www.palantir.com/docs/foundry/document-intelligence/document-to-text/#operation-signature-parameters).

##### Reference: Built-in transformations

For a complete reference of all available transformation methods, parameters, and examples, refer to the [media set transforms API documentation](https://www.palantir.com/docs/foundry/transforms-python/media-set-transforms-api/).

###### Convert a PDF document to JPEG images

Converts document pages to images with the specified dimensions.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **start\_page** (*Optional\[int]*): The zero-indexed start page for conversion. Defaults to 0 (the first page).
* **end\_page** (*Optional\[int]*): The zero-indexed end page for conversion (exclusive). Defaults to `None` (the last page).
* **width** (*Optional\[int]*): The width of the output images. Defaults to 1024.
* **height** (*Optional\[int]*): The height of the output images. Defaults to 1024.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the document to images transformation, allowing for further transformations.

**Example:**

```python
transform = pdf_input.transform().convert_document_to_images("ri.mio.main.media-item.1", 0, 5, 600, 900, output_format="jpg")
image_output.write(transform)
```

###### Transform a PDF document set into text with OCR

This transform uses traditional optical character recognition (OCR) to extract text from PDF documents, rather than AI-powered OCR, which uses a vision language model to perform the extraction. [Learn more about using a vision language model to extract PDF document content.](https://www.palantir.com/docs/foundry/transforms-python-spark/palantir-provided-models/#use-vision-language-models-to-extract-pdf-document-content).

**Parameters:**

* **languages** (*list\[str]*): List of languages to be used for OCR. Defaults to English. All valid codes can be found in the [Tesseract documentation ↗](https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions.html) under languages.
* **scripts** (*Optional\[list\[str]]*): List of scripts to be used for OCR. Defaults to `None`. All valid codes can be found in the [Tesseract documentation ↗](https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions.html) under scripts.
* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **start\_page** (*Optional\[int]*): The zero-indexed start page for OCR. Only applicable for PDF media sets. Defaults to `0` (the first page).
* **end\_page** (*Optional\[int]*): The zero-indexed end page for OCR (exclusive). Only applicable for PDF media sets. Defaults to `None` (the final page).
* **return\_structure** (*str*): `item_per_row` or `page_per_row`. Only applicable to transformations on an entire PDF media set. Defaults to `item_per_row`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame, list of strings, or a single string.
  * `str`: Transformations on a single image.
  * `list[str]`: Transformations on a single PDF.
  * `DataFrame`: Transformations on the entire media set.
    * For PDF (`item_per_row`): Columns are `media_item_rid`, `path`, `media_reference`, `extracted_text` (list\[str]).
    * For PDF (`page_per_row`) or image sets: Columns are `media_item_rid`, `path`, `media_reference`, `page_number`, `extracted_text` (str).

**Example:**

```python
df = media_set.transform().ocr()
dataset_output.write_dataframe(df)
```

###### Transcribe audio to text

Transcribe an audio file that contains speech into text.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **language** (*Optional\[str]*): The language to use for transcription. Defaults to `None`, in which case it will be auto-detected. Valid languages can be found in the [Whisper GitHub repo ↗](https://github.com/openai/whisper/blob/main/whisper/tokenizer.py) under `LANGUAGES`.
* **performance\_mode** (*Literal\["more\_economical", "more\_performant"]*): The performance mode to use for transcription. Defaults to `more_economical`.
* **output\_format** (*Literal\["text", "segments"]*): The format of the output. Defaults to `text`.
* **add\_timestamps** (*Optional\[bool]*): Control whether timestamps are added to the transcription. Defaults to `False`. Only applicable when output\_format is `text`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or a single string.
  * `str`: Applicable for transformations on a single item.
    * `text`: The transcribed text.
    * `segments`: JSON object containing the transcribed segments including timestamps, segment confidence and more details.
  * `DataFrame`: Columns are `media_item_rid`, `path`, `media_reference`, `transcription` (str). Applicable for transformations on the entire media set.

**Example:**

```python
df = media_set.transform().transcribe("ri.mio.main.media-item.1", language="english")
dataset_output.write_dataframe(df)
```

---

### Media set transforms API reference

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/media-set-transforms-api/

#### Media set transforms API

The media set transforms API provides methods for transforming media sets in Python transforms. This API enables various operations on media sets, such as extracting text using optical character recognition (OCR), resizing images, converting documents to images, and more.

##### Methods by schema type

| Schema type | Available methods |
| --- | --- |
| Image | [`resize`](#resize) • [`crop`](#crop) • [`binarize`](#binarize) • [`rotate`](#rotate) • [`grayscale`](#grayscale) • [`equalize`](#equalize) • [`rayleigh`](#rayleigh) • [`convert_image_to_document`](#convert_image_to_document) • [`generate_image_embeddings`](#generate_image_embeddings) • [`tile`](#tile) • [`ocr`](#ocr) • [`encrypt`](#encrypt) • [`decrypt`](#decrypt) |
| Document | [`ocr`](#ocr) • [`extract_raw_text`](#extract_raw_text) • [`convert_document_to_images`](#convert_document_to_images) • [`slice_document`](#slice_document) • [`extract_form_fields`](#extract_form_fields) • [`extract_table_of_contents`](#extract_table_of_contents) • [`get_pdf_page_dimensions`](#get_pdf_page_dimensions) |
| Video | [`extract_audio`](#extract_audio) • [`extract_scene_frames`](#extract_scene_frames) • [`chunk`](#chunk) • [`extract_first_frame`](#extract_first_frame) • [`extract_frames_at_timestamp`](#extract_frames_at_timestamp) • [`transcode`](#transcode) • [`get_scene_frame_timestamps`](#get_scene_frame_timestamps) |
| Audio | [`transcribe`](#transcribe) • [`chunk`](#chunk) • [`transcode`](#transcode) • [`get_waveform`](#get_waveform) |
| DICOM | [`render_dicom_layer`](#render_dicom_layer) |
| Spreadsheet | [`extract_content_from_spreadsheets`](#extract_content_from_spreadsheets) |
| Email | [`extract_email_body`](#extract_email_body) • [`extract_email_attachments`](#extract_email_attachments) |
| Multimodal | [`filter_to`](#filter_to) |

##### Getting started

To use the media set transforms API, access the transform functionality from a media set input as shown in the example below.

```python
from transforms.mediasets.inputs import MediaSetInputParam
from transforms.api import transform, Output, TransformOutput
from transforms.mediasets import MediaSetInput

@transform(
    media_input=MediaSetInput("/path/to/media_set"),
    dataset_output=Output("/path/to/output")
)
def compute(ctx, media_input: MediaSetInputParam, dataset_output: TransformOutput):
    # Create a MediaSetInputTransform instance
    transform = media_input.transform()

    # Apply transformations
    result = transform.ocr()

    # Write the result to output
    dataset_output.write_dataframe(result)
```

###### transform()

```python
def transform(self, deduplicate_by_path=True):
```

Returns a `MediaSetInputTransform` instance. This class enables fluent method chaining for media transformations on a media set input.

**Parameters:**

* **deduplicate\_by\_path** (*bool, optional*): If `True`, only the most recent item at each path will be included. Defaults to `True`.

**Returns:**

* `MediaSetInputTransform`: A user-facing class that provides methods for media set transformations.

**Example:**

```python
df = media_set.transform().ocr()
```

###### Writing a `MediaSetInputTransform` to a media set output

For media set to media set transformations, write the transformed media to a media set as shown in the example below.

```python
from transforms.mediasets.inputs import MediaSetInputParam
from transforms.mediasets.outputs import MediaSetOutputParam
from transforms.api import transform
from transforms.mediasets import MediaSetInput, MediaSetOutput


@transform(
    video_input=MediaSetInput(
        "/path/to/input_media_set"
    ),
    multimodal_output=MediaSetOutput(
        "/path/to/output_media_set"
    ),
)
def compute(
    ctx,
    video_input: MediaSetInputParam,
    multimodal_output: MediaSetOutputParam,
):
    def output_path_tar(input_path, page=None):
        return input_path.replace("mp4", "tar")

    multimodal_output.write(
        video_input.transform().extract_scene_frames(
            scene_sensitivity="LESS_SENSITIVE"
        ),
        output_path_tar,
    )
```

###### write()

```python
def write(
    self,
    media_transform: MediaSetInputTransform,
    output_path: Callable[[str, Optional[int]], str] = prefix_path,
    suppress_errors: bool = False,
    return_dataframe: bool = False,
) -> Union[str, DataFrame, None]:
```

Write a MediaSetInputTransform to an output media set.

**Parameters:**

* **media\_transform** (*MediaSetInputTransform*): A media set transform that has been applied to a media set input. For example: `media_transform = img_input.transform().resize()`
* **output\_path** (*Callable\[\[str, Optional\[int]], str], optional*): A function that determines the output path for each media item. It takes the original path and an optional page number as input and returns the new path. Defaults to prepending "transformed" to the original path. For media transformations that output multiple items per input media item, the item's path will automatically be appended with an identifying value. For example, [`crop`](#crop) transformations that apply multiple crops to an image will automatically include the crop parameters (x\_offset, y\_offset, width, height) in the path.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the dataframe's media\_reference column if return\_dataframe is `True`. If `False`, any errors will not be caught and the build will fail. Defaults to `False`. Only applicable to transformations on the entire media set.
* **return\_dataframe** (*bool, optional*): Only applicable for media set level transformation. If True, returns a dataframe which contains media\_item\_rid, path and media\_reference columns. The dataframe represents the media items written to the output media set. Defaults to False. If True, the media set transformations will be lazily evaluated.

**Returns:**

* None, a DataFrame or a string.
  * `str`: Applicable to transformations on an individual media item. Returns the resulting media reference string.
  * `None`: Applicable to transformations on an entire media set. Returns None if return\_dataframe is set to False.
  * `DataFrame`: Applicable to transformations on an entire media set and when return\_dataframe is set to True. Columns are `media_item_rid`, `path`, `media_reference`.

**Example:**

```python
# Media transformation on the whole media set
media_transform = img_input.transform().resize()
img_out.write(media_transform)

# Media transformation on an individual media item
media_transform = img_input.transform().resize(media_item_rid = "rid1")
med_ref_str = img_out.write(media_transform)
```

##### API reference

###### ocr()

Extracts text from PDFs or images using OCR and returns the extracted text as a string. Recommended for images and scanned documents.

**Parameters:**

* **languages** (*list\[str]*): List of languages to be used for OCR. Defaults to English. All valid codes can be found in the [Tesseract documentation ↗](https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions.html) under languages.
* **scripts** (*Optional\[list\[str]]*): List of scripts to be used for OCR. Defaults to `None`. All valid codes can be found in the [Tesseract documentation ↗](https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions.html) under scripts.
* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **start\_page** (*Optional\[int]*): The zero-indexed start page for OCR. Only applicable for PDF media sets. Defaults to `0` (the first page).
* **end\_page** (*Optional\[int]*): The zero-indexed end page for OCR (exclusive). Only applicable for PDF media sets. Defaults to `None` (the final page).
* **return\_structure** (*str*): `item_per_row` or `page_per_row`. Only applicable to transformations on an entire PDF media set. Defaults to `item_per_row`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame, list of strings, or a single string.
  * `str`: Transformations on a single image.
  * `list[str]`: Transformations on a single PDF.
  * `DataFrame`: Transformations on the entire media set.
    * For PDF (`item_per_row`): Columns are `media_item_rid`, `path`, `media_reference`, `extracted_text` (list\[str]).
    * For PDF (`page_per_row`) or image sets: Columns are `media_item_rid`, `path`, `media_reference`, `page_number`, `extracted_text` (str).

**Example:**

```python
df = media_set.transform().ocr()
dataset_output.write_dataframe(df)
```

###### extract\_raw\_text()

Extracts raw text from PDFs. Recommended for documents that have been electronically generated.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **start\_page** (*Optional\[int]*): The zero-indexed start page for text extraction. Defaults to 0 (the first page).
* **end\_page** (*Optional\[int]*): The zero-indexed end page for text extraction (exclusive). Defaults to `None` (the final page).
* **return\_structure** (*str*): `item_per_row` or `page_per_row`. Only applicable to transformations on an entire PDF media set. Defaults to `item_per_row`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or list of strings.
  * `str`: Applicable to transformations on a single image.
  * `list[str]`: Applicable to transformations on a single PDF.
  * `DataFrame`: Applicable to transformations on the entire media set.
    * PDF (`item_per_row`): Columns are `media_item_rid`, `path`, `media_reference`, `extracted_text` (list\[str]).
    * PDF (`page_per_row`) or image sets: Columns are `media_item_rid`, `path`, `media_reference`, `page_number`, `extracted_text` (str).

**Example:**

```python
df = media_set.transform().extract_raw_text()
dataset_output.write_dataframe(df)
```

###### resize()

Resizes images to the specified dimensions.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **width** (*Optional\[int]*): The target width for the resized images. Defaults to `1024`. Must be provided if height is not provided.
* **height** (*Optional\[int]*): The target height for the resized images. Defaults to `1024`. Must be provided if width is not provided.
* **maintain\_aspect\_ratio** (*bool*): Specifies whether to maintain the original aspect ratio of the images. If `True`, images will be resized to fit within the specified dimensions while preserving the aspect ratio. Defaults to `True`.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the resize transformation, allowing for further transformations.

**Example:**

```python
transform = image_input.transform().resize()
image_output.write(transform)
```

###### convert\_document\_to\_images()

Converts document pages to images with the specified dimensions.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **start\_page** (*Optional\[int]*): The zero-indexed start page for conversion. Defaults to 0 (the first page).
* **end\_page** (*Optional\[int]*): The zero-indexed end page for conversion (exclusive). Defaults to `None` (the last page).
* **width** (*Optional\[int]*): The width of the output images. Defaults to 1024.
* **height** (*Optional\[int]*): The height of the output images. Defaults to 1024.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the document to image transformation, allowing for further transformations.

**Example:**

```python
transform = pdf_input.transform().convert_document_to_images()
image_output.write(transform)
```

###### slice\_document()

Slices documents to a specified range of pages.

**Parameters:**

* **start\_page** (*int*): The zero-indexed start page for the slice operation.
* **end\_page** (*int*): The zero-indexed end page for the slice operation (exclusive).
* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **strictly\_enforce\_end\_page** (*bool*): Specifies behavior if the `end_page` exceeds the number of pages in the document. If `True`, an error will be raised. If `False`, the last page of the document is used instead. Defaults to `True`.

**Returns:**

* An instance of `MediaSetInputTransform` containing the slice transformation, allowing for further transformations.

**Example:**

```python
transform = pdf_input.transform().slice_document(0, 5)
pdf_output.write(transform)
```

###### tile()

Generates Slippy map tiles (EPSG 3857) from images. Only supports geo-embedded images in TIFF or NITF format, with a maximum size of 100 million square pixels.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **zoom** (*Union\[int, Column]*): Zoom level of the tile. Must be a non-negative integer. At zoom level `0`, the entire world fits into a single tile. Each increment doubles the spatial resolution and quadruples the number of tiles. Defaults to `0`.
* **x** (*Union\[int, Column]*): Tile column index at the specified zoom level. Increases from west to east. Valid range: `0 <= x < 2**zoom`. Defaults to `0`.
* **y** (*Union\[int, Column]*): Tile row index at the specified zoom level. Increases from north to south. Valid range: `0 <= y < 2**zoom`. Defaults to `0`.
* **df** (*Optional\[DataFrame]*): Specifies the DataFrame to join on when passing column inputs. Tiling will only be applied to media items present in both the input media set and provided DataFrame. Must be provided together with the `on` parameter.
* **on** (*Optional\[Literal\["media\_item\_rid", "media\_reference"]]*): The column name to join on when `df` is specified. This aligns the tiling operation with the correct media item.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the tile transformation, allowing for further transformations.

**Example:**

```python
# Dynamically select tiling parameters from the input_df columns.
# Only tiles media items in both the media set and provided DataFrame.
transform1 = image_input.transform().tile(input_df.zoom, input_df.x, input_df.y, df=input_df, on="media_item_rid")

# All tiles will be generated with the same parameters.
# Generates a tile for all media items in the media set.
transform2 = image_input.transform().tile(zoom=2, x=1, y=1)

# Write the transformation to output media set
image_output.write(transform)
```

###### encrypt()

Encrypts specified regions of images using the provided cipher image key.

**Parameters:**

* **polygons** (*Union\[list\[api.Polygon], Column]*): The regions to encrypt, specified as polygons.
* **cipher\_license\_rid** (*Union\[str, Column]*): The cipher license RID to use for encryption.
* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **df** (*Optional\[DataFrame]*): Specifies the DataFrame to join on when passing column inputs. Encryption will only be applied to media items present in both the input media set and provided DataFrame. Must be provided together with the `on` parameter.
* **on** (*Optional\[Literal\["media\_item\_rid", "media\_reference"]]*): The column name to join on when `df` is specified. This aligns the encryption operation with the correct media item.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the encrypt transformation, allowing for further transformations.

**Example:**

```python
polygon = [api.Coordinate(x=10, y=10), api.Coordinate(x=100, y=10),
           api.Coordinate(x=100, y=100), api.Coordinate(x=10, y=100)]
transform = image_input.transform().encrypt([polygon], "cipher_license_rid_123", media_item_rid="rid1")
image_output.write(transform)
```

###### decrypt()

Decrypts specified regions of images using the provided cipher image key.

**Parameters:**

* **polygons** (*Union\[list\[api.Polygon], Column]*): The regions to decrypt, specified as a list of polygons.
* **cipher\_license\_rid** (*Union\[str, Column]*): The resource identifier for the cipher license to use for decryption.
* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **df** (*Optional\[DataFrame]*): Specifies the DataFrame to join on when passing column inputs. Decryption will only be applied to media items present in both the input media set and provided DataFrame. Must be provided together with the `on` parameter.
* **on** (*Optional\[Literal\["media\_item\_rid", "media\_reference"]]*): The column name to join on when `df` is specified. This aligns the decryption operation with the correct media item.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the decrypt transformation, allowing for further transformations.

**Example:**

```python
polygon = [api.Coordinate(x=10, y=10), api.Coordinate(x=100, y=10),
           api.Coordinate(x=100, y=100), api.Coordinate(x=10, y=100)]
transform = image_input.transform().decrypt([polygon], "cipher_license_rid_123", media_item_rid="rid1")
image_output.write(transform)
```

###### crop()

Crops images using specified dimensions and offsets.

**Parameters:**

* **width** (*Union\[int, Column]*): The width of the cropped image.
* **height** (*Union\[int, Column]*): The height of the cropped image.
* **x\_offset** (*Union\[int, Column]*): The x-coordinate of the top-left corner of the crop area. Defaults to `0`.
* **y\_offset** (*Union\[int, Column]*): The y-coordinate of the top-left corner of the crop area. Defaults to `0`.
* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **df** (*Optional\[DataFrame]*): Specifies the DataFrame to join on when passing column inputs. Cropping will only be applied to media items present in both the input media set and provided DataFrame. Must be provided together with the `on` parameter.
* **on** (*Optional\[Literal\["media\_item\_rid", "media\_reference"]]*): The column name to join on when `df` is specified. This aligns the cropping operation with the correct media item.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the crop transformation, allowing for further transformations.

**Examples:**

```python
# All media items will be cropped with the same parameters.
# Crops all media items in the media set.
transform = image_input.transform().crop(100, 100, 10, 10)
image_output.write(transform)

# Dynamically select cropping parameters from the input_df columns.
# Only crops media items in both the media set and provided DataFrame.
transform1 = image_input.transform().crop(input_df.x2 - input_df.x1, input_df.y2 - input_df.y1,
    input_df.x1, input_df.y1, df=input_df, on="media_item_rid")

# Width and height are dynamically selected from the input_df columns, while the offsets are static.
# Only crops media items in both the media set and provided DataFrame.
transform2 = image_input.transform().crop(30, 50,
    input_df.x1, input_df.y1, df=input_df, on="media_item_rid")

# All media items will be cropped with the same parameters.
# Only crops media items in both the media set and provided DataFrame.
transform3 = image_input.transform().crop(30, 50,
    20, 60, df=input_df, on="media_item_rid")

# All media items will be cropped with the same parameters.
# Crops all media items in the media set.
transform4 = image_input.transform().crop(30, 50, 20, 60)

# Write the transformation to output media set
image_output.write(transform1)
```

###### binarize()

Converts images to binary using the specified threshold.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **threshold** (*Optional\[int]*): Values above or equal to the threshold will be assigned a value of `255` and values below will be assigned a value of `0`. Defaults to computing the threshold based on the input image.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the binarize transformation, allowing for further transformations.

**Example:**

```python
transform = image_input.transform().binarize(threshold=150)
image_output.write(transform)
```

###### rotate()

Rotates images by the specified angle.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **angle** (*Literal\["DEGREE\_90", "DEGREE\_180", "DEGREE\_270"]*): The angle to rotate the images. Defaults to `DEGREE_90`.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the rotate transformation, allowing for further transformations.

**Example:**

```python
transform = image_input.transform().rotate(angle="DEGREE_180")
image_output.write(transform)
```

###### grayscale()

Converts images to grayscale.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the grayscale transformation, allowing for further transformations.

**Example:**

```python
transform = image_input.transform().grayscale()
image_output.write(transform)
```

###### equalize()

Improves the clarity of low-contrast images by performing histogram equalization on grayscale images.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the equalize transformation, allowing for further transformations.

**Example:**

```python
transform = image_input.transform().equalize()
image_output.write(transform)
```

###### rayleigh()

Adjusts the grayscale intensity values so the image's histogram (the distribution of pixel brightness) matches the Rayleigh distribution (roughly a bell curve that is always negative). This can improve clarity in low-contrast images.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **sigma** (*float*): The scaling parameter for the Rayleigh distribution. Must be a floating point numeral between 0 and 1. Defaults to 0.5.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the rayleigh transformation, allowing for further transformations.

**Example:**

```python
transform = image_input.transform().rayleigh(sigma=0.7)
image_output.write(transform)
```

###### convert\_image\_to\_document()

Converts images to PDFs.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.

**Returns:**

* An instance of `MediaSetInputTransform` containing the convert image to document transformation, allowing for further transformations.

**Example:**

```python
transform = image_input.transform().convert_image_to_document()
pdf_output.write(transform)
```

###### transcode()

Transcodes audio or video to the specified format.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **encode\_format** (*Optional\[str]*): Specifies the format in which the output media will be encoded. Defaults to MP4 for video and MP3 for audio.

**Returns:**

* An instance of `MediaSetInputTransform` containing the transcode transformation, allowing for further transformations.

**Example:**

```python
transform = video_input.transform().transcode(encode_format="mov")
video_output.write(transform)
```

###### extract\_audio()

Extracts audio from video files.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **output\_format** (*str*): The format of the output audio (e.g., `mp3`, `wav`). Defaults to `mp3`.

**Returns:**

* An instance of `MediaSetInputTransform` containing the audio extraction transformation, allowing for further transformations.

**Example:**

```python
transform = video_input.transform().extract_audio(output_format="wav")
audio_output.write(transform)
```

###### extract\_scene\_frames()

Extracts all scene frames from videos as images. A scene frame is a video frame that marks the beginning of a new scene or a significant visual transition in the video content.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **scene\_sensitivity** (*Literal\["MORE\_SENSITIVE", "STANDARD", "LESS\_SENSITIVE"]*): The sensitivity level for scene detection. Defaults to `STANDARD`.
* **output\_format** (*str*): Specifies the encoding format for extracted frames. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the scene frame extraction transformation. The output images for each video will be stored in a TAR archive file.

**Example:**

```python
transform = video_input.transform().extract_scene_frames(scene_sensitivity="MORE_SENSITIVE")
multimodal_output.write(transform)
```

###### chunk()

Chunks audio or video files into smaller segments of the specified duration.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **chunk\_duration\_milliseconds** (*int*): The duration of each chunk in milliseconds. Defaults to `10000` (10 seconds). Must be a positive integer.
* **output\_format** (*Optional\[str]*): The format of the output audio chunks. Defaults to MP4 for video and TS for audio; TS is the only supported output format for audio.

**Returns:**

* An instance of `MediaSetInputTransform` containing the chunking transformation, allowing for further transformations.

**Example:**

```python
transform = video_input.transform().chunk(chunk_duration_milliseconds=5000)
video_output.write(transform)
```

###### extract\_first\_frame()

Extracts the first full scene frame from videos as an image with the specified dimensions, or the original dimensions if not provided.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **width** (*Optional\[int]*): The target width for the extracted frames. If `None`, width will be scaled based on the provided height. Defaults to `None`.
* **height** (*Optional\[int]*): The target height for the extracted frames. If `None`, height will be scaled based on the provided width. Defaults to `None`.
* **output\_format** (*str*): The format of the output images. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the first frame extraction transformation, allowing for further transformations.

**Example:**

```python
transform = video_input.transform().extract_first_frame(width=800, height=600)
image_output.write(transform)
```

###### extract\_frames\_at\_timestamp()

Extracts frames from videos at a specified timestamp, using the specified dimensions, or the original dimensions if not provided.

**Parameters:**

* **timestamps** (*Union\[float, Column]*): The timestamp in seconds at which to extract frames.
* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **df** (*Optional\[DataFrame]*): Specifies the DataFrame to join on when passing column inputs. Frame extraction will only be applied to media items present in both the input media set and provided DataFrame. Must be provided together with the `on` parameter.
* **on** (*Optional\[Literal\["media\_item\_rid", "media\_reference"]]*): The column name to join on when `df` is specified. This aligns the frame extraction operation with the correct media item.
* **width** (*Optional\[int]*): The target width for the extracted frames. If `None`, scales width based on the provided height. Defaults to `None`.
* **height** (*Optional\[int]*): The target height for the extracted frames. If `None`, scales height based on provided width. Defaults to `None`.
* **output\_format** (*str*): The format of the output images. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the frame extraction transformation, allowing for further transformations.

**Example:**

```python
# Dynamically select timestamp parameters from the input_df columns.
# Only extracts frames from media items in both the media set and provided DataFrame.
transform1 = video_input.transform().extract_frames_at_timestamp(input_df.timestamp, df=input_df, on="media_item_rid")

# All frames will be extracted at the same timestamp for all items in the media set.
transform2 = video_input.transform().extract_frames_at_timestamp(30)

# Write the transformation to output media set
image_output.write(transform1)
```

###### render\_dicom\_layer()

Renders a frame of a DICOM file as an image, using the specified dimensions, or the original dimensions if not provided.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **layer\_number** (*Optional\[int]*): The layer number to render from the DICOM image. Defaults to the middle layer.
* **width** (*Optional\[int]*): The target width for the rendered image. If `None`, and height is provided, the aspect ratio will be preserved. Must be provided if height is not provided.
* **height** (*Optional\[int]*): The target height for the rendered image. If `None`, and width is provided, the aspect ratio will be preserved. Must be provided if width is not provided.
* **output\_format** (*str*): The format of the output images, for example PNG or JPEG. Defaults to PNG.

**Returns:**

* An instance of `MediaSetInputTransform` containing the render DICOM layer transformation, allowing for further transformations.

**Example:**

```python
transform = dicom_input.transform().render_dicom_layer(layer_number=2)
image_output.write(transform)
```

###### extract\_form\_fields()

Extracts form fields from documents.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or a single string.
  * `str`: JSON object containing form fields. Applicable for transformations on a single item.
  * `DataFrame`: Columns are `media_item_rid`, `path`, `media_reference`, `form_fields` (str). Applicable for transformations on the entire media set.

**Example:**

```python
df = media_set.transform().extract_form_fields()
dataset_output.write_dataframe(df)
```

###### extract\_table\_of\_contents()

Extracts the table of contents from documents.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or a single string.
  * `str`: JSON object containing table of contents. Applicable for transformations on a single item.
  * `DataFrame`: Columns are `media_item_rid`, `path`, `media_reference`, `table_of_contents` (str). Applicable for transformations on the entire media set.

**Example:**

```python
df = media_set.transform().extract_table_of_contents()
dataset_output.write_dataframe(df)
```

###### get\_pdf\_page\_dimensions()

Returns PDF page dimensions.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or a single string.
  * `str`: JSON object containing a list of dictionaries with keys `width` and `height`. Applicable for transformations on a single item.
  * `DataFrame`: Columns are `media_item_rid`, `path`, `media_reference`, `page_dimensions` (str). Applicable for transformations on the entire media set.

**Example:**

```python
df = media_set.transform().get_pdf_page_dimensions()
dataset_output.write_dataframe(df)
```

###### generate\_image\_embeddings()

Generates embeddings for images.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **model\_id** (*Optional\[str]*): The model to use to generate image embeddings. Defaults to `GOOGLE_SIGLIP_2`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or a single string.
  * `str`: JSON object containing vector embeddings. Applicable for transformations on a single item.
  * `DataFrame`: Columns are `media_item_rid`, `path`, `media_reference`, `embeddings` (str). Applicable for transformations on the entire media set.

**Example:**

```python
df = media_set.transform().generate_image_embeddings()
dataset_output.write_dataframe(df)
```

###### get\_waveform()

Returns waveform amplitudes for audio files.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **peaks\_per\_second** (*Optional\[int]*): Number of peaks per second to return. Defaults to `100`. Must be a positive non-zero integer up to `1000`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or a single string.
  * `str`: JSON object containing a list of doubles representing audio amplitudes and normalized between 0 and 1. Applicable for transformations on a single item.
  * `DataFrame`: Columns are `media_item_rid`, `path`, `media_reference`, `waveform` (str). Applicable for transformations on the entire media set.

**Example:**

```python
df = media_set.transform().get_waveform()
dataset_output.write_dataframe(df)
```

###### transcribe()

Transcribes audio.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **language** (*Optional\[str]*): The language to use for transcription. Defaults to `None`, in which case it will be auto-detected. Valid languages can be found in the [Whisper GitHub repo ↗](https://github.com/openai/whisper/blob/main/whisper/tokenizer.py) under `LANGUAGES`.
* **performance\_mode** (*Literal\["more\_economical", "more\_performant"]*): The performance mode to use for transcription. Defaults to `more_economical`.
* **output\_format** (*Literal\["text", "segments"]*): The format of the output. Defaults to `text`.
* **add\_timestamps** (*Optional\[bool]*): Control whether timestamps are added to the transcription. Defaults to `False`. Only applicable when output\_format is `text`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or a single string.
  * `str`: Applicable for transformations on a single item.
    * `text`: The transcribed text.
    * `segments`: JSON object containing the transcribed segments including timestamps, segment confidence and more details.
  * `DataFrame`: Columns are `media_item_rid`, `path`, `media_reference`, `transcription` (str). Applicable for transformations on the entire media set.

**Example:**

```python
df = media_set.transform().transcribe(output_format="segments")
dataset_output.write_dataframe(df)
```

###### get\_scene\_frame\_timestamps()

Returns timestamps for scene frames from video files.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **scene\_sensitivity** (*Literal\["MORE\_SENSITIVE", "STANDARD", "LESS\_SENSITIVE"]*): The sensitivity level for scene detection. Defaults to `STANDARD`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or a single string.
  * `str`: JSON object containing a list of scene frames with keys `timestamp` and `sceneScore` in the `frames` field. Applicable for transformations on a single item.
  * `DataFrame`: Columns are `media_item_rid`, `path`, `media_reference`, `scene_frames` (str). Applicable for transformations on the entire media set.

**Example:**

```python
df = media_set.transform().get_scene_frame_timestamps()
dataset_output.write_dataframe(df)
```

###### extract\_email\_body()

Extracts the body of emails.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **output\_format** (*Literal\["TEXT", "HTML"]*): Specifies the output format for the extracted content. Defaults to `TEXT`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or a single string.
  * `str`: Email body in the specified format. Applicable for transformations on a single item.
  * `DataFrame`: Columns are `media_item_rid`, `path`, `media_reference`, `email_body` (str). Applicable for transformations on the entire media set.

**Example:**

```python
df = media_set.transform().extract_email_body()
dataset_output.write_dataframe(df)
```

###### extract\_email\_attachments()

Extracts attachments from emails.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **schema\_type** (*Optional\[Literal\["audio", "image", "video", "document", "spreadsheet", "dicom", "email"]]*): Only extract attachments of the specified schema type. Defaults to `None`, which extracts all attachments.

**Returns:**

* An instance of `MediaSetInputTransform` containing the extract email attachments transformation, allowing for further transformations.

**Example:**

```python
transform = email_input.transform().extract_email_attachments()
multimodal_output.write(transform)
```

###### filter\_to()

Filters the media set to only include items of the specified schema type and (optional) formats.

**Parameters:**

* **schema\_type** (*Literal\["audio", "image", "video", "document", "spreadsheet", "dicom", "email"]*): The schema type on which to filter.
* **formats** (*Optional\[list\[str]]*): Optional list of specific formats on which to filter. If not provided, all formats within the schema type are included. Available formats by schema type:
  * document: `pdf`, `docx`, `pptx`, `txt`
  * image: `png`, `jpeg`, `jpg`, `tiff`, `bmp`, `webp`, `jp2`, `jp2k`, `nitf`
  * audio: `mp3`, `wav`, `flac`, `ogg`, `opus`, `m4a`, `webm_audio`
  * video: `mp4`, `ts`, `mov`, `mkv`
  * spreadsheet: `xlsx`
  * email: `eml`
  * dicom: Does not support format narrowing

**Returns:**

* An instance of `MediaSetInputTransform` containing the filter transformation, allowing for further transformations.

**Example:**

```python
# Filter to all documents
transform = media_set.transform().filter_to("document").slice_document(0, 5)

# Filter to only PDFs and perform OCR
transform = media_set.transform().filter_to("document", formats=["pdf"]).ocr()

# Filter to PDFs and DOCX files
transform = media_set.transform().filter_to("document", formats=["pdf", "docx"])
pdf_output.write(transform)
```

###### extract\_content\_from\_spreadsheets()

Extracts content from spreadsheet files.

**Parameters:**

* **media\_item\_rid** (*Optional\[str]*): If specified, will run the transformation on the specified item instead of the entire media set. Defaults to `None`.
* **suppress\_errors** (*bool*): Specifies error handling behavior. If `True`, errors are caught and the error message will be returned in the output. If `False`, any errors will not be caught and the build will fail. Defaults to `True`. Only applicable to transformations on the entire media set.

**Returns:**

* A DataFrame or a single string.
  * `str`: JSON object containing a key for each sheet name, and its value having fields `table` and `merged_cells`. Applicable for transformations on a single item.
  * `DataFrame`: Columns are `media_item_rid`, `path`, `media_reference`, `extracted_content` (str). Applicable for transformations on the entire media set.

**Example:**

```python
df = media_set.transform().extract_content_from_spreadsheets()
dataset_output.write_dataframe(df)
```
