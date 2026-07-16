CREATE TYPE "public"."entity_status" AS ENUM('active', 'idle', 'archived');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hash" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"url" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"type" text NOT NULL,
	"status" "entity_status" DEFAULT 'active' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parent" text,
	"head_seq" bigint,
	"snapshot_offset" bigint,
	"archived_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_tags" (
	"url" text NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "entity_tags_url_tag_pk" PRIMARY KEY("url","tag")
);
--> statement-breakpoint
ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_url_entities_url_fk" FOREIGN KEY ("url") REFERENCES "public"."entities"("url") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "entities_tenant_idx" ON "entities" USING btree ("tenant");--> statement-breakpoint
CREATE INDEX "entities_type_idx" ON "entities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "entities_parent_idx" ON "entities" USING btree ("parent");--> statement-breakpoint
CREATE INDEX "entities_status_idx" ON "entities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "entity_tags_tag_idx" ON "entity_tags" USING btree ("tag");