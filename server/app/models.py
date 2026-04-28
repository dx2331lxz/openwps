from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: str
    content: Optional[str] = None
    attachments: Optional[list[dict[str, Any]]] = None
    tool_calls: Optional[list[dict[str, Any]]] = None
    toolCalls: Optional[list[dict[str, Any]]] = None
    tool_call_id: Optional[str] = None
    agentTraces: Optional[list[dict[str, Any]]] = None
    name: Optional[str] = None
    thinking: Optional[str] = None


class OCRConfig(BaseModel):
    enabled: bool = True
    backend: str = "compat_chat"
    providerId: str = "siliconflow"
    endpoint: str = ""
    model: str = "PaddlePaddle/PaddleOCR-VL-1.5"
    apiKey: Optional[str] = None
    hasApiKey: bool = False
    timeoutSeconds: int = 60
    maxImages: int = 5


class VisionConfig(BaseModel):
    enabled: bool = False
    providerId: str = "openai"
    endpoint: str = ""
    model: str = "gpt-4o-mini"
    apiKey: Optional[str] = None
    hasApiKey: bool = False
    timeoutSeconds: int = 30


class TavilyConfig(BaseModel):
    enabled: bool = True
    apiKey: Optional[str] = None
    hasApiKey: bool = False
    searchDepth: str = "basic"
    topic: str = "general"
    maxResults: int = 5
    timeoutSeconds: int = 15


class OCRCommandRequest(BaseModel):
    images: list[dict[str, Any]] = Field(default_factory=list)
    taskType: str = "general_parse"
    instruction: Optional[str] = None
    imageIndices: list[int] = Field(default_factory=list)
    ocrConfig: Optional[OCRConfig] = None


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = Field(default_factory=list)
    context: dict[str, Any] = Field(default_factory=dict)
    conversationId: Optional[str] = None
    reactMessages: list[dict[str, Any]] = Field(default_factory=list)
    mode: str = "agent"
    images: list[dict[str, Any]] = Field(default_factory=list)
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    model: Optional[str] = None
    providerId: Optional[str] = None
    imageProcessingMode: str = "direct_multimodal"
    ocrConfig: Optional[OCRConfig] = None
    ocrResults: list[dict[str, Any]] = Field(default_factory=list)
    documentSessionId: Optional[str] = None


class CompletionRequest(BaseModel):
    providerId: Optional[str] = None
    model: Optional[str] = None
    activity: str = "standard"
    candidateCount: int = 1
    cursorPos: int = 0
    prefixText: str = ""
    suffixText: str = ""
    paragraphText: str = ""
    previousParagraphText: str = ""
    nextParagraphText: str = ""
    wordCount: int = 0
    pageCount: int = 1
    paragraphCount: int = 0
    maxChars: int = 80


class ProviderSettings(BaseModel):
    id: str
    label: str
    endpoint: str
    defaultModel: str = ""
    apiKey: Optional[str] = None
    isPreset: bool = False
    supportsVision: bool = False
    promptCacheMode: str = "off"
    promptCacheRetention: str = "in_memory"


class SettingsUpdate(BaseModel):
    activeProviderId: str
    imageProcessingMode: str = "direct_multimodal"
    ocrConfig: OCRConfig = Field(default_factory=OCRConfig)
    visionConfig: VisionConfig = Field(default_factory=VisionConfig)
    tavilyConfig: TavilyConfig = Field(default_factory=TavilyConfig)
    providers: list[ProviderSettings] = Field(default_factory=list)


class ModelDiscoveryRequest(BaseModel):
    endpoint: Optional[str] = None
    apiKey: Optional[str] = None
    providerId: Optional[str] = None


class VisionTestRequest(BaseModel):
    providerId: Optional[str] = None
    endpoint: Optional[str] = None
    model: Optional[str] = None
    apiKey: Optional[str] = None
    timeoutSeconds: int = 30


class VisionAnalyzeRequest(BaseModel):
    image: dict[str, Any] = Field(default_factory=dict)
    providerId: Optional[str] = None
    model: Optional[str] = None
    instruction: Optional[str] = None
    context: Optional[dict[str, Any]] = None
    timeoutSeconds: Optional[int] = None


class DocumentSettingsUpdateRequest(BaseModel):
    activeSource: Optional[str] = None
    wpsDirectory: Optional[str] = None


class WorkspaceCreateRequest(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None


class WorkspaceMoveRequest(BaseModel):
    toPath: str


class WorkspaceOpenRequest(BaseModel):
    path: str


class DocumentSessionCreateRequest(BaseModel):
    docJson: Optional[dict[str, Any]] = None
    pageConfig: Optional[dict[str, Any]] = None
    selectionContext: Optional[dict[str, Any]] = None
    currentDocumentName: Optional[str] = None
    workspaceId: Optional[str] = None
    filePath: Optional[str] = None
    fileType: Optional[str] = None


class DocumentSessionPatchRequest(BaseModel):
    baseVersion: Optional[int] = None
    docJson: Optional[dict[str, Any]] = None
    pageConfig: Optional[dict[str, Any]] = None
    selectionContext: Optional[dict[str, Any]] = None
    clientId: Optional[str] = None
    workspaceId: Optional[str] = None
    filePath: Optional[str] = None
    fileType: Optional[str] = None


class DocumentSessionActiveRequest(BaseModel):
    clientId: Optional[str] = None
    currentDocumentName: Optional[str] = None
    workspaceId: Optional[str] = None
    filePath: Optional[str] = None
    fileType: Optional[str] = None


class DocumentToolExecuteRequest(BaseModel):
    toolName: str
    params: dict[str, Any] = Field(default_factory=dict)
    baseVersion: Optional[int] = None
    selectionContext: Optional[dict[str, Any]] = None


class AppendMessagesRequest(BaseModel):
    messages: list[ChatMessage]


class TaskCreateRequest(BaseModel):
    subject: str
    description: str
    activeForm: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


class TaskUpdateRequest(BaseModel):
    subject: Optional[str] = None
    description: Optional[str] = None
    activeForm: Optional[str] = None
    status: Optional[str] = None
    owner: Optional[str] = None
    addBlocks: Optional[list[str]] = None
    addBlockedBy: Optional[list[str]] = None
    metadata: Optional[dict[str, Any]] = None


class TemplateCreateRequest(BaseModel):
    name: str
    note: Optional[str] = None
    summary: str
    sourceFilename: str
    sourceContentBase64: str
    templateText: str = ""


class TemplateUpdateRequest(BaseModel):
    name: Optional[str] = None
    note: Optional[str] = None
    templateText: Optional[str] = None


class TemplateAnalyzeRequest(BaseModel):
    name: str
    sourceFilename: str
    sourceContentBase64: str
    rawText: str = ""
    providerId: Optional[str] = None
    model: Optional[str] = None
