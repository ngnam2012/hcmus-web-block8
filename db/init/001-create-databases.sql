-- Two logically independent databases on the same PostgreSQL server.
-- No transaction can span sender_db and receiver_db.
CREATE DATABASE sender_db;
CREATE DATABASE receiver_db;
