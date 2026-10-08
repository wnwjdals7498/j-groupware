import type { Pool } from "pg";
import type {
  BoardPost,
  BoardList,
  CreateBoardPost,
} from "@j-groupware/contracts";
import { ApiError } from "../errors.js";
interface Row {
  id: string;
  author_id: string;
  title: string;
  body: string;
  created_at: Date;
  cursor_time: string;
}
const post = (row: Row): BoardPost => ({
  id: row.id,
  authorId: row.author_id,
  title: row.title,
  body: row.body,
  createdAt: row.created_at.toISOString(),
});
export class BoardStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
  ) {}
  async create(subject: string, input: CreateBoardPost): Promise<BoardPost> {
    const result = await this.pool.query<Row>(
      "INSERT INTO board_posts(tenant_id,author_id,title,body) VALUES($1,$2,$3,$4) RETURNING *",
      [this.tenant, subject, input.title, input.body],
    );
    return post(result.rows[0]!);
  }
  async read(id: string): Promise<BoardPost> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM board_posts WHERE tenant_id=$1 AND id=$2",
      [this.tenant, id],
    );
    if (!result.rows[0])
      throw new ApiError(404, "not_found", "Post not found.");
    return post(result.rows[0]);
  }
  async list(cursor?: string): Promise<BoardList> {
    let time: string | null = null,
      id: string | null = null;
    if (cursor) {
      try {
        const value: unknown = JSON.parse(
          Buffer.from(cursor, "base64url").toString(),
        );
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          typeof value[0] !== "string" ||
          value[0].startsWith("0000-") ||
          !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+00$/.test(
            value[0],
          ) ||
          typeof value[1] !== "string" ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value[1])
        )
          throw new Error();
        const date = new Date(value[0].replace(" ", "T") + ":00");
        if (
          !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 19) !==
            value[0].slice(0, 19).replace(" ", "T")
        )
          throw new Error();
        [time, id] = value as [string, string];
      } catch {
        throw new ApiError(400, "invalid_input", "Invalid cursor.");
      }
    }
    const result = await this.pool.query<Row>(
      "SELECT *,created_at::text AS cursor_time FROM board_posts WHERE tenant_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51",
      [this.tenant, time, id],
    );
    const page = result.rows.slice(0, 50),
      last = page.at(-1);
    return {
      items: page.map(post),
      nextCursor:
        result.rows.length > 50 && last
          ? Buffer.from(JSON.stringify([last.cursor_time, last.id])).toString(
              "base64url",
            )
          : null,
    };
  }
}
