-- Enable pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Create HNSW index for cosine distance vector search
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding_hnsw 
ON "CodeChunk" 
USING hnsw (embedding vector_cosine_ops);