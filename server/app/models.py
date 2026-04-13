from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: str
    content: Optional[str] = None
    tool_calls: Optional[list[dict[str, Any]]] = None
    toolCalls: Optional[list[dict[str, Any]]] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None
    thinking: Optional[str] = None


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = Field(default_factory=list)
    context: dict[str, Any] = Field(default_factory=dict)
    conversationId: Optional[str] = None
    reactMessages: list[dict[str, Any]] = Field(default_factory=list)
    mode: str = "agent"
    images: list[dict[str, Any]] = Field(default_factory=list)
    model: Optional[str] = None
    providerId: Optional[str] = None


class ProviderSettings(BaseModel):
    id: str
    label: str
    endpoint: str
    defaultModel: str = ""
    apiKey: Optional[str] = None
    isPreset: bool = False


class SettingsUpdate(BaseModel):
    activeProviderId: str
    providers: list[ProviderSettings] = Field(default_factory=list)


class ModelDiscoveryRequest(BaseModel):
    endpoint: Optional[str] = None
    apiKey: Optional[str] = None
    providerId: Optional[str] = None


class AppendMessagesRequest(BaseModel):
    messages: list[ChatMessage]


class ToolResultItem(BaseModel):
    execution_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    content: str


class ToolResultsRequest(BaseModel):
    plan_id: Optional[str] = None
    round: Optional[int] = None
    results: list[ToolResultItem] = Field(default_factory=list)
    stop: bool = False
