// Optional embedding provider (vector retrieval). BLOCKED in this deployment: no embedding credentials/model are
// configured, and we do not fake vectors. Full-text (FTS5 trigram + BM25 re-rank) is the only retrieval path.
//
// To unblock: implement EmbeddingProvider (e.g. an OpenAI-compatible /embeddings endpoint or a local ONNX model),
// register it with `knowledgeAdmin.setEmbeddingProvider(p)`, add a `kb_vectors` table (chunk_seq, model, dims, vector BLOB)
// filled by the ingest pipeline after indexing, and merge vector hits with FTS hits (reciprocal-rank fusion) inside
// KnowledgeStore.search — keeping the same SQL ACL filter on kb_id.
export interface EmbeddingProvider {
	readonly id: string;
	readonly dimensions: number;
	embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface EmbeddingStatus {
	readonly status: "blocked";
	readonly detail: string;
}

export function embeddingStatus(provider: EmbeddingProvider | null): EmbeddingStatus {
	return provider
		? { status: "blocked", detail: `已注册嵌入模型 ${provider.id}，但向量索引与混合排序尚未实现` }
		: { status: "blocked", detail: "未配置嵌入模型凭据（无 embedding provider），向量检索不可用；当前仅全文检索（FTS5 trigram + BM25）" };
}
