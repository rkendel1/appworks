import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assessmentDigest, evidenceId, type ApplicationAssessment, type Evidence } from "../src/index.js";

export const MEMOS_FIXTURE = fileURLToPath(new URL("./fixtures/memos", import.meta.url));
export const MEMOS_COMMIT = "c0eeec7a260ee58e2ed1514a61bfff1fa013f42e";

export const tempDir = (prefix = "assessment-") => mkdtempSync(join(tmpdir(), prefix));

/** Writes files (path → content) under `root`, in the given order. */
export function writeTree(root: string, files: Record<string, string>, order: "as-given" | "reversed" = "as-given") {
  const entries = Object.entries(files);
  for (const [path, content] of order === "reversed" ? entries.reverse() : entries) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** A content hash of a tree: every path, type, mode, link target and file content, `.git` included. */
export function treeHash(root: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      hash.update(`${path.slice(root.length)}\0${stat.mode}\0${stat.mtimeMs}\0`);
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(root);
  return hash.digest("hex");
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Recomputes evidence ids (rewriting references, until stable) and the digest after a deliberate edit, so only the edit is tested. */
export function reseal(a: ApplicationAssessment): ApplicationAssessment {
  let current = clone(a);
  for (;;) {
    const renamed = new Map<string, string>();
    for (const e of current.evidence) {
      const { id, ...content } = e;
      const next = evidenceId(content as Omit<Evidence, "id">);
      if (next !== id) renamed.set(id, next);
    }
    if (!renamed.size) break;
    current = JSON.parse(JSON.stringify(current).replace(/"(ev-[0-9a-f]{16})"/g, (m, id: string) => (renamed.has(id) ? `"${renamed.get(id)}"` : m))) as ApplicationAssessment;
  }
  return { ...current, digest: assessmentDigest(current) };
}

/**
 * A small synthetic Go service: one proto service with two RPCs, handlers with validation and authorization codes,
 * a store with SQL, and a test. `options` add the constructs the safety tests need.
 */
export function syntheticApp(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "go.mod": "module example.com/notes\n\ngo 1.22\n\nrequire google.golang.org/grpc v1.60.0\n",
    "proto/notes.proto": `syntax = "proto3";
package notes.v1;
import "google/api/annotations.proto";
import "google/api/field_behavior.proto";
import "google/protobuf/timestamp.proto";

service NoteService {
  rpc GetNote(GetNoteRequest) returns (Note) {
    option (google.api.http) = {get: "/v1/{name=notes/*}"};
  }
  rpc DeleteNote(DeleteNoteRequest) returns (Note) {
    option (google.api.http) = {delete: "/v1/{name=notes/*}"};
  }
}

message Note {
  string name = 1 [(google.api.field_behavior) = OUTPUT_ONLY];
  string body = 2;
  int64 revision = 3;
  google.protobuf.Timestamp create_time = 4;
  Visibility visibility = 5;
  map<string, string> labels = 6;
}

enum Visibility {
  VISIBILITY_UNSPECIFIED = 0;
  PRIVATE = 1;
}

message GetNoteRequest {
  string name = 1 [(google.api.field_behavior) = REQUIRED];
}

message DeleteNoteRequest {
  string name = 1 [(google.api.field_behavior) = REQUIRED];
}
`,
    "server/service.go": `package server

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "example.com/notes/gen/notes"
	"example.com/notes/store"
)

type Service struct {
	Store *store.Store
}

func (s *Service) GetNote(ctx context.Context, request *pb.GetNoteRequest) (*pb.Note, error) {
	if request.Name == "" {
		return nil, status.Errorf(codes.InvalidArgument, "name is required")
	}
	if !s.allowed(ctx) {
		return nil, status.Errorf(codes.PermissionDenied, "permission denied")
	}
	note, err := s.Store.GetNote(ctx, request.Name)
	if err != nil {
		return nil, err
	}
	return note, nil
}

func (s *Service) DeleteNote(ctx context.Context, request *pb.DeleteNoteRequest) (*pb.Note, error) {
	if request.Name == "" {
		return nil, status.Errorf(codes.InvalidArgument, "name is required")
	}
	if !s.allowed(ctx) {
		return nil, status.Errorf(codes.Unauthenticated, "sign in")
	}
	return s.Store.DeleteNote(ctx, request.Name)
}

func (s *Service) allowed(ctx context.Context) bool {
	return ctx != nil
}
`,
    "store/store.go": `package store

import (
	"context"
	"database/sql"
)

type Store struct {
	db *sql.DB
}

func (s *Store) GetNote(ctx context.Context, name string) (*Note, error) {
	row := s.db.QueryRowContext(ctx, "SELECT body FROM note WHERE name = ?", name)
	return scan(row)
}

func (s *Store) DeleteNote(ctx context.Context, name string) (*Note, error) {
	_, err := s.db.ExecContext(ctx, \`DELETE FROM note
WHERE name = ?\`, name)
	return nil, err
}

type Note struct{}

func scan(row *sql.Row) (*Note, error) {
	return &Note{}, nil
}
`,
    "server/service_test.go": `package server

import (
	"context"
	"testing"

	pb "example.com/notes/gen/notes"
)

func TestGetNote(t *testing.T) {
	s := &Service{}
	_, _ = s.GetNote(context.Background(), &pb.GetNoteRequest{Name: "notes/1"})
}

func TestDeleteNote(t *testing.T) {
	s := &Service{}
	_, _ = s.DeleteNote(context.Background(), &pb.DeleteNoteRequest{Name: "notes/1"})
}
`,
    ...extra
  };
}
