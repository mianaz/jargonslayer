import { describe, expect, it } from "vitest";
import { POST } from "../route";

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function makeFormRequest(
  file: File | null,
  extraHeaders: Record<string, string> = {},
): Request {
  const form = new FormData();
  if (file) form.set("file", file);
  return new Request("http://localhost/api/transcribe-cloud", {
    method: "POST",
    body: form,
    headers: extraHeaders,
  });
}

function makeFile(sizeBytes: number, name = "audio.wav"): File {
  const blob = new Blob([new Uint8Array(sizeBytes)], { type: "audio/wav" });
  return new File([blob], name, { type: "audio/wav" });
}

describe("POST /api/transcribe-cloud — upload size caps", () => {
  it("rejects a request whose Content-Length header exceeds 200MB with 413, before calling formData()", async () => {
    const req = makeFormRequest(makeFile(10), {
      "content-length": String(MAX_UPLOAD_BYTES + 1),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("rejects a parsed file larger than 200MB even when Content-Length was absent/understated", async () => {
    // No content-length header set explicitly (native FormData bodies
    // don't populate it), so this only fails once the file itself is
    // inspected post-formData().
    const req = makeFormRequest(makeFile(MAX_UPLOAD_BYTES + 1));
    const res = await POST(req);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("does not reject a normal-sized upload on size grounds (fails later for missing API key instead)", async () => {
    const req = makeFormRequest(makeFile(1024));
    const res = await POST(req);
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("no_key");
  });
});
