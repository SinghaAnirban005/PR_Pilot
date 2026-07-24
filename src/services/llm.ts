import { env } from "../config/env.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

export class LlmError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteChatOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

interface GroqChatResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
}

export async function completeChat(options: CompleteChatOptions): Promise<string> {
  const { messages, temperature = 0.2, maxTokens = 2048, jsonMode = true } = options;

  let response: Response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  } catch (err) {
    throw new LlmError("Network error calling Groq API", err);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable body>");
    throw new LlmError(`Groq API returned ${response.status}: ${body}`);
  }

  const data = (await response.json()) as GroqChatResponse;
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new LlmError("Groq API response contained no message content");
  }

  return content;
}

export function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenceMatch?.[1] ?? trimmed;
}