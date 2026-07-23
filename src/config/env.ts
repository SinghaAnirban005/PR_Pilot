import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(3000),

  GITHUB_APP_ID: z.string().min(1, "GITHUB_APP_ID is required"),
  GITHUB_PRIVATE_KEY: z
    .string()
    .min(1, "GITHUB_PRIVATE_KEY is required")
    .transform((key) => key.replace(/\\n/g, "\n")),
  GITHUB_WEBHOOK_SECRET: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),
  GITHUB_INSTALLATION_ID: z.string().optional(),

  DATABASE_URL: z
    .string()
    .url("DATABASE_URL must be a valid postgres connection string"),
  DATABASE_SSL: z.coerce.boolean().default(false),

  HF_TOKEN: z.string().min(1, "HF_TOKEN is required"),
  HF_EMBEDDING_MODEL: z.string().default("BAAI/bge-m3"),
  HF_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),

  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),

  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  MAX_LLM_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  VECTOR_TOP_K: z.coerce.number().int().positive().default(8),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid env:\n${formatted}`);
    throw new Error("Environment validation failed. See logs above.");
  }

  return parsed.data;
}

export const env: Env = loadEnv();
