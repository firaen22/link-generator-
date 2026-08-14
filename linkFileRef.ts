// Server-side mirror of resolveFileId() in src/utils/pdfBridge.ts.
//
// /api/pdf is handed an already-encoded file id by the reader. When the request
// also carries a link id (?lid=), the proxy must confirm that id really is the
// document that link points at — otherwise one live link would act as a key for
// every document in the bucket. This maps a Firestore `f` value onto the same
// (kind, raw) pair the encoded id decodes to, so the two can be compared without
// re-deriving base64 on the server.
//
// Keep in sync with resolveFileId — the three legal shapes of `f` are a full
// URL, an "r2:"-prefixed key, and a bare Firebase Storage path.

export type PdfRefKind = "r2" | "vblob" | "f";

export interface PdfRef {
  kind: PdfRefKind;
  raw: string;
}

/** The (kind, raw) pair a Firestore `f` field should resolve to. */
export function refFromFileField(f: string): PdfRef | null {
  if (typeof f !== "string" || f === "") return null;

  if (f.includes("://") || f.includes("firebasestorage.googleapis.com")) {
    const isR2 = f.includes("r2.cloudflarestorage.com") || f.includes("r2.dev");
    return { kind: isR2 ? "r2" : "vblob", raw: f };
  }

  if (f.startsWith("r2:")) {
    return { kind: "r2", raw: f.slice(3) };
  }

  return { kind: "f", raw: f };
}

/**
 * The (kind, raw) pair an encoded /api/pdf/:file_id carries.
 * `decode` is the caller's url-safe-base64 decoder (server.ts already has one).
 */
export function refFromFileId(
  fileId: string,
  decode: (encoded: string) => string,
): PdfRef | null {
  if (typeof fileId !== "string") return null;

  if (fileId.startsWith("r2_")) {
    const raw = decode(fileId.slice(3));
    return raw ? { kind: "r2", raw } : null;
  }
  if (fileId.startsWith("vblob_")) {
    const raw = decode(fileId.slice(6));
    return raw ? { kind: "vblob", raw } : null;
  }
  if (fileId.startsWith("f_")) {
    const raw = decode(fileId.slice(2));
    return raw ? { kind: "f", raw } : null;
  }
  return null;
}

/** True when the encoded id is exactly the document the link's `f` names. */
export function fileIdMatchesLink(
  fileId: string,
  f: string,
  decode: (encoded: string) => string,
): boolean {
  const want = refFromFileField(f);
  const got = refFromFileId(fileId, decode);
  if (!want || !got) return false;
  return want.kind === got.kind && want.raw === got.raw;
}
