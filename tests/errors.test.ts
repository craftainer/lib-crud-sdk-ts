import { describe, expect, it } from "vitest";
import {
  BadRequest,
  CrudError,
  Forbidden,
  Locked,
  NotFound,
  PreconditionFailed,
  ProblemError,
  RateLimited,
  ServerError,
  Unauthorized,
  ValidationFailed,
  problemFromResponse,
} from "../src/index.ts";

const problem = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  problemFromResponse(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers,
    }),
  );

describe("problemFromResponse", () => {
  it.each([
    [400, BadRequest],
    [401, Unauthorized],
    [403, Forbidden],
    [404, NotFound],
    [412, PreconditionFailed],
    [422, ValidationFailed],
    [423, Locked],
    [429, RateLimited],
    [500, ServerError],
    [503, ServerError],
    [409, ProblemError],
  ])("maps %i", async (status, cls) => {
    const error = await problem(status, {});
    expect(error).toBeInstanceOf(cls);
    expect(error).toBeInstanceOf(CrudError);
    expect(error.name).toBe(cls.name);
  });

  it("reads RFC 9457 members", async () => {
    const error = await problem(409, {
      type: "https://e.test/x",
      title: "Conflict!",
      detail: "taken",
      instance: "/a/1",
    });
    expect(error).toMatchObject({
      status: 409,
      title: "Conflict!",
      detail: "taken",
      type: "https://e.test/x",
      instance: "/a/1",
      errors: [],
      message: "409 Conflict!: taken",
    });
    expect(error.response).toBeInstanceOf(Response);
  });

  it("synthesizes a problem from the status phrase for a non-JSON body", async () => {
    const error = await problem(502, "<html>bad gateway</html>");
    expect(error).toMatchObject({
      status: 502,
      title: "Bad Gateway",
      type: "about:blank",
      detail: undefined,
      instance: undefined,
      message: "502 Bad Gateway",
    });
  });

  it("uses the status phrase for a non-object JSON body and unknown statuses", async () => {
    expect((await problem(404, "[1]")).title).toBe("Not Found");
    expect((await problem(499, "null")).title).toBe("Error");
    expect((await problem(404, { title: "", type: "" })).title).toBe(
      "Not Found",
    );
  });

  it("normalizes a list detail into errors", async () => {
    const error = await problem(422, {
      detail: [
        { loc: ["body", "name"], msg: "too short", type: "string_too_short" },
        { loc: "x", msg: 5 },
        { loc: [], msg: undefined },
        "plain",
        7,
      ],
    });
    expect(error).toBeInstanceOf(ValidationFailed);
    expect(error.detail).toBeUndefined();
    expect(error.errors).toEqual([
      { loc: ["body", "name"], msg: "too short", type: "string_too_short" },
      { loc: [], msg: "5", type: "" },
      { loc: [], msg: "", type: "" },
      { loc: [], msg: "plain", type: "" },
      { loc: [], msg: "7", type: "" },
    ]);
    expect(
      error.message.startsWith(
        "422 Unprocessable Content: body.name: too short; ",
      ),
    ).toBe(true);
  });

  it("reads an `errors` member when detail is not a list", async () => {
    const error = await problem(400, {
      detail: "bad",
      errors: [{ loc: ["q"], msg: "m" }],
    });
    expect(error.detail).toBe("bad");
    expect(error.errors).toEqual([{ loc: ["q"], msg: "m", type: "" }]);
    expect(error.message).toBe("400 Bad Request: bad");
  });

  it("keeps the WWW-Authenticate challenge on 401", async () => {
    const withChallenge = await problem(
      401,
      {},
      { "www-authenticate": 'Bearer realm="x"' },
    );
    expect((withChallenge as Unauthorized).wwwAuthenticate).toBe(
      'Bearer realm="x"',
    );
    expect(
      ((await problem(401, {})) as Unauthorized).wwwAuthenticate,
    ).toBeUndefined();
  });

  it("parses Retry-After on 429", async () => {
    const retry = async (value?: string) =>
      (
        (await problem(
          429,
          {},
          value === undefined ? {} : { "retry-after": value },
        )) as RateLimited
      ).retryAfter;
    expect(await retry("30")).toBe(30);
    expect(await retry("1.5")).toBe(1.5);
    expect(await retry()).toBeUndefined();
    expect(await retry("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
    expect(await retry(" ")).toBeUndefined();
    expect(await retry("0")).toBe(0);
    for (const bad of ["Infinity", "-Infinity", "-1", "-0.5", "1e999"]) {
      expect(await retry(bad)).toBeUndefined();
    }
  });

  it("leaves the response body readable", async () => {
    const error = await problem(400, { title: "t" });
    expect(await error.response?.json()).toEqual({ title: "t" });
  });

  it("builds a bare ProblemError", () => {
    const error = new ProblemError({ status: 418, title: "Teapot" });
    expect(error.headers).toBeInstanceOf(Headers);
    expect(error.errors).toEqual([]);
    expect(error.type).toBe("about:blank");
  });
});
