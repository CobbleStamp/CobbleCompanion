CREATE TABLE "active_embodiment" (
	"companion_id" uuid PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"node" text NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"last_heartbeat" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "active_embodiment" ADD CONSTRAINT "active_embodiment_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;