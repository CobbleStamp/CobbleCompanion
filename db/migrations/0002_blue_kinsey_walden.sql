CREATE TABLE "user_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"learned_by_companion_id" uuid,
	"learned_from_seq" bigint,
	"fact_type" text NOT NULL,
	"subject" text NOT NULL,
	"predicate" text,
	"object" text NOT NULL,
	"confidence" real,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_learned_by_companion_id_companions_id_fk" FOREIGN KEY ("learned_by_companion_id") REFERENCES "public"."companions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_superseded_by_user_facts_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."user_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_facts_user_current_idx" ON "user_facts" USING btree ("user_id","superseded_at");