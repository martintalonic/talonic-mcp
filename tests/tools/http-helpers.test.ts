import { afterEach, describe, expect, it, vi } from "vitest"
import { apiBinary, apiForm, apiJson, filenameFromDisposition, sleep } from "../../src/tools/_http"

const getToken = () => "tlnc_test"

describe("apiForm", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("posts multipart/form-data with repeated array fields and the bearer, skipping undefined", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ run_id: "r1", status: "processing" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
      }),
    )
    const out = await apiForm<{ run_id: string }>(getToken, "https://api.example.test", "/v1/run", {
      spec_id: "s1",
      file_urls: ["https://a.example/x.pdf", "https://a.example/y.pdf"],
      name: undefined,
      pipeline_mode: "new",
    })
    expect(out.run_id).toBe("r1")
    expect(calls[0].url).toBe("https://api.example.test/v1/run")
    expect(calls[0].init.method).toBe("POST")
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get("authorization")).toBe("Bearer tlnc_test")
    expect(headers.get("accept")).toBe("application/json")
    // undici sets the multipart boundary itself — we must NOT set Content-Type.
    expect(headers.get("content-type")).toBeNull()
    const body = calls[0].init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get("spec_id")).toBe("s1")
    expect(body.getAll("file_urls")).toEqual(["https://a.example/x.pdf", "https://a.example/y.pdf"])
    expect(body.has("name")).toBe(false)
    expect(body.get("pipeline_mode")).toBe("new")
  })

  it("throws the API error envelope on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"bad_request"}', { status: 400 })),
    )
    await expect(apiForm(getToken, undefined, "/v1/run", { spec_id: "s1" })).rejects.toThrow(
      /HTTP 400.*bad_request/,
    )
  })
})

describe("apiJson method union", () => {
  afterEach(() => vi.unstubAllGlobals())
  it("accepts PATCH and DELETE", async () => {
    const fetchFn = vi.fn(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    )
    vi.stubGlobal("fetch", fetchFn)
    await apiJson(getToken, undefined, "PATCH", "/v1/x", { body: { a: 1 } })
    await apiJson(getToken, undefined, "DELETE", "/v1/x")
    expect((fetchFn.mock.calls[0][1] as RequestInit).method).toBe("PATCH")
    expect((fetchFn.mock.calls[1][1] as RequestInit).method).toBe("DELETE")
  })

  it("forwards an AbortSignal to the fetch init", async () => {
    const fetchFn = vi.fn(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    )
    vi.stubGlobal("fetch", fetchFn)
    const controller = new AbortController()
    await apiJson(getToken, undefined, "GET", "/v1/x", { signal: controller.signal })
    expect((fetchFn.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal)
  })
})

describe("sleep", () => {
  afterEach(() => vi.useRealTimers())

  it("resolves after the given delay", async () => {
    vi.useFakeTimers()
    const p = sleep(500)
    vi.advanceTimersByTime(500)
    await expect(p).resolves.toBeUndefined()
    vi.useRealTimers()
  })
})

describe("apiBinary", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("GETs with the bearer and returns bytes, filename and media type", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(Buffer.from("abc"), {
        headers: {
          "content-type": "application/pdf; charset=binary",
          "content-disposition": 'attachment; filename="a%20b.pdf"',
        },
      }),
    )
    vi.stubGlobal("fetch", fetchFn)
    const file = await apiBinary(getToken, undefined, "/v1/x", {
      params: { kind: "pdf" },
      maxBytes: 10,
    })
    expect(fetchFn.mock.calls[0][0]).toBe("https://api.talonic.com/v1/x?kind=pdf")
    const init = fetchFn.mock.calls[0][1] as RequestInit
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tlnc_test")
    expect(file).toEqual({
      bytes: Buffer.from("abc"),
      filename: "a b.pdf",
      mimeType: "application/pdf",
    })
  })

  it("refuses a body over the limit by Content-Length or by size read", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("x".repeat(20), { headers: { "content-length": "20" } })),
    )
    await expect(apiBinary(getToken, undefined, "/v1/x", { maxBytes: 10 })).rejects.toThrow(
      "20 bytes, over the 10-byte limit",
    )
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(20))))
    await expect(apiBinary(getToken, undefined, "/v1/x", { maxBytes: 10 })).rejects.toThrow(
      "over the 10-byte limit",
    )
  })

  it("throws the API error envelope on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("gone", { status: 410 })))
    await expect(apiBinary(getToken, undefined, "/v1/x", { maxBytes: 10 })).rejects.toThrow(
      "HTTP 410 — gone",
    )
  })
})

describe("filenameFromDisposition", () => {
  it("reads quoted, RFC 5987 and bare filenames", () => {
    expect(filenameFromDisposition('attachment; filename="a%20b.docx"')).toBe("a b.docx")
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%C3%A4.pdf")).toBe("ä.pdf")
    expect(filenameFromDisposition("attachment; filename=plain.docx")).toBe("plain.docx")
    expect(filenameFromDisposition("attachment")).toBeNull()
    expect(filenameFromDisposition(null)).toBeNull()
  })
})
