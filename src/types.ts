export type TranscriptSegment = {
  index: number;
  start: number;
  end: number;
  text: string;
};

export type TranscriptRecord = {
  transcriptId: string;
  workId: string;
  sourceUrl: string;
  title: string;
  author?: string | null;
  model: string;
  method: "local-qwen3-asr";
  language?: string | null;
  durationSeconds: number | null;
  createdAt: string;
  device?: string;
  computeType?: string;
  requestedLanguage?: "Chinese" | "auto";
  chunkSeconds?: number;
  contextApplied?: boolean;
  contextVersion?: string | null;
  cacheHit?: boolean;
  text: string;
  segments: TranscriptSegment[];
};
