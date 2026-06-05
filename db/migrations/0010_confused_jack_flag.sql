ALTER TABLE "messages" ADD COLUMN "kind" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "metadata" jsonb;