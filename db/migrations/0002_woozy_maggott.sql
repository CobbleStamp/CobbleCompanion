CREATE TABLE "equipped_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"companion_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"source" text NOT NULL,
	"server_ref" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"equipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_catalog" (
	"tool_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"server_ref" text NOT NULL,
	"tool_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "mcp_connections" CASCADE;--> statement-breakpoint
ALTER TABLE "equipped_tools" ADD CONSTRAINT "equipped_tools_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "equipped_tools_companion_tool_uniq" ON "equipped_tools" USING btree ("companion_id","tool_id");--> statement-breakpoint
CREATE INDEX "equipped_tools_companion_lru_idx" ON "equipped_tools" USING btree ("companion_id","last_used_at");