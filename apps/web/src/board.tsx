import { useState } from "react";
import { Button, Card, DataTable, Dialog, TextField } from "@j-groupware/ui";
import type { BoardList, BoardPost } from "@j-groupware/contracts";
import type { Api } from "./api.js";
import { encoded } from "./api.js";
import {
  Feedback,
  Form,
  NextPage,
  TextArea,
  useAction,
  useQuery,
} from "./common.js";

export function Board({ api, canWrite }: { api: Api; canWrite: boolean }) {
  const [cursor, setCursor] = useState("");
  const list = useQuery<BoardList>(
    api,
    "/api/board/posts" + (cursor ? "?cursor=" + encoded(cursor) : ""),
  );
  const action = useAction();
  const [post, setPost] = useState<BoardPost>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <>
      <h1>게시판</h1>
      <Feedback {...list} {...action} />
      <Card title="게시글">
        <Button variant="secondary" onClick={list.reload}>
          새로고침
        </Button>
        <DataTable
          caption="게시글 목록"
          rows={list.value?.items ?? []}
          getRowKey={(row) => row.id}
          columns={[
            {
              key: "title",
              header: "제목",
              cell: (row) => (
                <Button
                  variant="quiet"
                  onClick={() =>
                    void action.run(
                      async () =>
                        setPost(
                          await api.request<BoardPost>(
                            "/api/board/posts/" + encoded(row.id),
                          ),
                        ),
                      "게시글을 열었습니다.",
                    )
                  }
                >
                  {row.title}
                </Button>
              ),
            },
            {
              key: "createdAt",
              header: "작성 시각",
              cell: (row) => row.createdAt,
            },
          ]}
        />
        <NextPage cursor={list.value?.nextCursor} onNext={setCursor} />
      </Card>
      {canWrite ? (
        <Card title="글 작성">
          <Form
            label="게시글 작성"
            busy={action.busy}
            onSubmit={() =>
              action.run(async () => {
                await api.request("/api/board/posts", "POST", { title, body });
                setTitle("");
                setBody("");
                setCursor("");
                list.reload();
              })
            }
          >
            <TextField
              label="제목"
              name="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
            />
            <TextArea
              label="본문"
              name="body"
              value={body}
              onChange={setBody}
            />
            <Button type="submit">게시</Button>
          </Form>
        </Card>
      ) : null}
      {post ? (
        <Dialog open title={post.title} onClose={() => setPost(undefined)}>
          <p className="plain-body">{post.body}</p>
        </Dialog>
      ) : null}
    </>
  );
}
