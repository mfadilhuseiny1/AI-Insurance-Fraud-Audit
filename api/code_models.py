"""Palantir-provided language models in Python transforms (palantir.com/docs/foundry/transforms-python-spark/palantir-provided-models).

The modules `palantir_models`, `palantir_models.transforms`, `palantir_models.models` and
`language_model_service_api.*` for repository code. A transform declares a model like an input
(`model=OpenAiGptChatLanguageModelInput("ri.language-model-service..language-model.<model id>")`) and receives a
model object whose calls go to this platform's models through the API (`/api/code-repos/tools/models/*`), with
the build's job token: the runner itself holds no provider secrets. The model id after `language-model.` is one of
the Model Catalog's ids; Foundry's own names (gpt-4_azure, text-embedding-ada-002_azure, ...) map to this
platform's default chat / embedding model.

`ModelInput("ri.models.main.model.<id>" or a path, "<version rid or semver>")` is a model resource (model_assets.py):
the build resolves the version into spec["container_models"]; the transform gets a model_container.ContainerModel
for a container-backed model, or the loaded adapter of a model trained here (model_lib.py; `use_sidecar=True`: in
its own process).
"""

from __future__ import annotations

import json
import os
import sys
import types
import urllib.error
import urllib.request
from typing import Any, Optional

RID_PREFIX = "ri.language-model-service..language-model."


def model_id(rid: str) -> str:
    rid = str(rid or "").strip()
    return rid[len(RID_PREFIX):] if rid.startswith(RID_PREFIX) else rid


CONTAINER_RID = "ri.models.main.model."


class ModelInput:
    """A language or embedding model declared as a transform parameter, or (a model asset resource identifier with a
    version) a container-backed model."""

    kind = "chat"

    def __init__(self, rid: str, model_version: Optional[str] = None, use_sidecar: bool = False, branch: Optional[str] = None,
                 sidecar_resources: Optional[dict] = None, **_: object) -> None:
        if not rid:
            raise TypeError(f"{type(self).__name__}(...) needs a model resource identifier")
        self.rid = rid
        self.version = model_version
        self.branch = branch
        self.use_sidecar = bool(use_sidecar)
        self.sidecar_resources = dict(sidecar_resources or {})
        if self.sidecar_resources and not self.use_sidecar:
            raise TypeError("sidecar_resources can only be used with use_sidecar=True")
        if str(rid).startswith(CONTAINER_RID) or (type(self) is ModelInput and "/" in str(rid)):
            # a model resource (by rid or path): container-backed or trained here, told apart when the build resolves it
            self.kind = "container"

    def describe(self) -> dict:
        if self.kind == "container":
            return {"kind": "container", "rid": self.rid, "version": self.version, "branch": self.branch, "use_sidecar": self.use_sidecar,
                    "class": type(self).__name__}
        return {"kind": self.kind, "rid": self.rid, "model": model_id(self.rid), "class": type(self).__name__}


class OpenAiGptChatLanguageModelInput(ModelInput):
    kind = "openai"


class GenericChatCompletionLanguageModelInput(ModelInput):
    kind = "chat"


class AnthropicClaudeLanguageModelInput(ModelInput):
    kind = "anthropic"


class GenericCompletionLanguageModelInput(ModelInput):
    kind = "chat"


class GenericVisionCompletionLanguageModelInput(ModelInput):
    kind = "chat"


class GenericEmbeddingModelInput(ModelInput):
    kind = "embedding"


# ------------------------------------------------------------------------------------------------
# language_model_service_api: requests and responses
# ------------------------------------------------------------------------------------------------


class ChatMessageRole:
    SYSTEM = "SYSTEM"
    USER = "USER"
    ASSISTANT = "ASSISTANT"


class ChatMessage:
    def __init__(self, role: str, content: str) -> None:
        self.role = str(getattr(role, "value", role)).upper()
        self.content = content


class _Request:
    def __init__(self, messages: Optional[list] = None, max_tokens: Optional[int] = None, temperature: Optional[float] = None, **kw: Any) -> None:
        self.messages = list(messages or [])
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.extra = kw


class GptChatCompletionRequest(_Request):
    pass


class GenericChatCompletionRequest(_Request):
    pass


class AnthropicMessagesRequest(_Request):
    pass


class GenericEmbeddingsRequest:
    def __init__(self, inputs: list[str], **_: object) -> None:
        self.inputs = [str(x) for x in inputs]


class _Obj:
    def __init__(self, **kw: Any) -> None:
        self.__dict__.update(kw)

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.__dict__})"


# ------------------------------------------------------------------------------------------------
# models (what the compute function receives)
# ------------------------------------------------------------------------------------------------


def _call(path: str, body: dict) -> dict:
    url = os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000").rstrip("/") + "/api/code-repos/tools/models/" + path
    token = os.environ.get("BLUESANDAI_API_TOKEN")
    if not token and os.environ.get("BLUESANDAI_MODELS_OFFLINE") != "1":
        raise RuntimeError("language models are available in previews and builds (they call the platform with the build's token)")
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except ValueError:
            pass
        raise RuntimeError(f"language model call failed ({e.code}): {detail}") from None


def _messages(req: _Request) -> list[dict]:
    return [{"role": m.role, "content": m.content} for m in req.messages]


class _ChatModel:
    def __init__(self, spec: ModelInput) -> None:
        self.rid = spec.rid
        self.model = model_id(spec.rid)

    def _complete(self, req: _Request) -> str:
        return _call("chat", {"model": self.model, "messages": _messages(req), "max_tokens": req.max_tokens, "temperature": req.temperature})["content"]


class OpenAiGptChatLanguageModel(_ChatModel):
    def create_chat_completion(self, request: GptChatCompletionRequest):
        text = self._complete(request)
        return _Obj(choices=[_Obj(message=_Obj(content=text, role=ChatMessageRole.ASSISTANT), finish_reason="stop", index=0)])


class GenericChatCompletionLanguageModel(_ChatModel):
    def create_chat_completion(self, request: GenericChatCompletionRequest):
        text = self._complete(request)
        return _Obj(completion=text, choices=[_Obj(message=_Obj(content=text))])


class AnthropicClaudeLanguageModel(_ChatModel):
    def create_chat_completion(self, request: AnthropicMessagesRequest):
        text = self._complete(request)
        return _Obj(content=[_Obj(type="text", text=text)], completion=text)

    create_messages = create_chat_completion


class GenericEmbeddingModel:
    def __init__(self, spec: ModelInput) -> None:
        self.rid = spec.rid
        self.model = model_id(spec.rid)

    def create_embeddings(self, request: GenericEmbeddingsRequest):
        res = _call("embeddings", {"model": self.model, "inputs": request.inputs})
        return _Obj(embeddings=res["embeddings"])


MODEL_CLASSES = {"openai": OpenAiGptChatLanguageModel, "chat": GenericChatCompletionLanguageModel, "anthropic": AnthropicClaudeLanguageModel,
                 "embedding": GenericEmbeddingModel}


def instance(spec: ModelInput, resolved: Optional[dict] = None):
    if spec.kind == "container":
        if not resolved:
            raise RuntimeError(f"the model {spec.rid} was not resolved for this run")
        import model_telemetry  # the model's calls in this transform are recorded and reported

        if resolved.get("kind") == "python":
            # a model trained here (model_lib.py): loaded in this process, or in its own with use_sidecar=True
            import model_lib

            m = model_lib.RemoteModel(resolved, resolved.get("param")) if spec.use_sidecar else model_lib.load_version(resolved, resolved.get("param"))
            return model_telemetry.trace_model(m, resolved)
        import model_container

        return model_telemetry.trace_model(model_container.ContainerModel(resolved), resolved)
    return MODEL_CLASSES[spec.kind](spec)


def install() -> None:
    """The palantir_models and language_model_service_api modules."""
    pm = types.ModuleType("palantir_models")
    pm.__path__ = []  # type: ignore[attr-defined]
    import model_container

    model_container.install(pm)
    pmt = types.ModuleType("palantir_models.transforms")
    for c in (ModelInput, OpenAiGptChatLanguageModelInput, GenericChatCompletionLanguageModelInput, AnthropicClaudeLanguageModelInput,
              GenericCompletionLanguageModelInput, GenericVisionCompletionLanguageModelInput, GenericEmbeddingModelInput):
        setattr(pmt, c.__name__, c)
    pmm = types.ModuleType("palantir_models.models")
    for c in (OpenAiGptChatLanguageModel, GenericChatCompletionLanguageModel, AnthropicClaudeLanguageModel, GenericEmbeddingModel):
        setattr(pmm, c.__name__, c)
    pm.transforms, pm.models = pmt, pmm  # type: ignore[attr-defined]
    import model_lib

    sys.modules["palantir_models.models"] = pmm
    model_lib.extend(pmt, pmm)
    lms = types.ModuleType("language_model_service_api")
    lms.__path__ = []  # type: ignore[attr-defined]
    api = types.ModuleType("language_model_service_api.languagemodelservice_api")
    api.ChatMessage, api.ChatMessageRole = ChatMessage, ChatMessageRole
    comp = types.ModuleType("language_model_service_api.languagemodelservice_api_completion_v3")
    comp.GptChatCompletionRequest, comp.GenericChatCompletionRequest, comp.AnthropicMessagesRequest = (
        GptChatCompletionRequest, GenericChatCompletionRequest, AnthropicMessagesRequest)
    emb = types.ModuleType("language_model_service_api.languagemodelservice_api_embeddings_v3")
    emb.GenericEmbeddingsRequest = GenericEmbeddingsRequest
    sys.modules.update({"palantir_models": pm, "palantir_models.transforms": pmt, "palantir_models.models": pmm,
                        "language_model_service_api": lms, "language_model_service_api.languagemodelservice_api": api,
                        "language_model_service_api.languagemodelservice_api_completion_v3": comp,
                        "language_model_service_api.languagemodelservice_api_embeddings_v3": emb})
