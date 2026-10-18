-- Respaldo completo de rewards_db (rewards-service): esquema + datos de ejemplo (database/seed.sql).
-- Generado con pg_dump --no-owner --no-privileges. Restaurar en una base vacía:
--   psql "$DATABASE_URL" -f database/backup.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: points_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.points_entries (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    points integer NOT NULL,
    kind character varying(10) NOT NULL,
    title character varying(80) NOT NULL,
    detail character varying(160) DEFAULT ''::character varying NOT NULL,
    source_key character varying(80) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.redemptions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    reward_id character varying(20) NOT NULL,
    kind character varying(10) NOT NULL,
    points integer NOT NULL,
    idempotency_key uuid NOT NULL,
    status character varying(10) NOT NULL,
    operator_code character varying(40),
    phone character varying(10),
    coupon_code character varying(20),
    expires_at timestamp with time zone,
    ledger_transaction_id uuid,
    failure_reason character varying(200),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Data for Name: points_entries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.points_entries (id, id_user, points, kind, title, detail, source_key, created_at) FROM stdin;
40000000-0000-4000-8000-000000000001	11111111-1111-4111-8111-111111111111	85	earn	Pago de factura	Acueducto de Bogotá · $85.000	earn:7b000000-0000-4000-8000-000000000004	2026-10-04 15:00:00+00
\.


--
-- Data for Name: redemptions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.redemptions (id, id_user, reward_id, kind, points, idempotency_key, status, operator_code, phone, coupon_code, expires_at, ledger_transaction_id, failure_reason, created_at, updated_at) FROM stdin;
\.


--
-- Name: points_entries PK_65c6da170aeec36e4870a88336e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_entries
    ADD CONSTRAINT "PK_65c6da170aeec36e4870a88336e" PRIMARY KEY (id);


--
-- Name: redemptions PK_def143ab94376fea5985bb04219; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redemptions
    ADD CONSTRAINT "PK_def143ab94376fea5985bb04219" PRIMARY KEY (id);


--
-- Name: idx_points_entries_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_points_entries_user_created ON public.points_entries USING btree (id_user, created_at);


--
-- Name: idx_redemptions_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_redemptions_user_created ON public.redemptions USING btree (id_user, created_at);


--
-- Name: uq_points_entries_user_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_points_entries_user_source ON public.points_entries USING btree (id_user, source_key);


--
-- Name: uq_redemptions_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_redemptions_idempotency ON public.redemptions USING btree (idempotency_key);


--
-- PostgreSQL database dump complete
--


