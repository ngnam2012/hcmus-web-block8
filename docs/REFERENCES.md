# Tài liệu tham khảo

Đã đối chiếu ngày 15/11/2026. 

1. **Đề và các phần A–D, E** — contract API, tám quy tắc, bốn phiên bản, oracle B0/H0/H1/F1–F8:
   <https://pub.nndkhoa9.win/webadv/w7/block-08-broker-interactive.html#1>
2. **RabbitMQ — Consumer Acknowledgements and Publisher Confirms** — confirm khác consumer ack; ack sau xử lý, tự requeue khi connection/channel mất, prefetch:
   <https://www.rabbitmq.com/docs/confirms>
3. **RabbitMQ — Work Queues (JavaScript)** — competing consumers, durability, manual acknowledgement, fair dispatch:
   <https://www.rabbitmq.com/tutorials/tutorial-two-javascript>
4. **RabbitMQ — Time-To-Live and Expiration** — TTL queue dùng cho retry có delay:
   <https://www.rabbitmq.com/docs/ttl>
5. **RabbitMQ — Dead Letter Exchanges** — định tuyến DLX và giới hạn an toàn; hardcoded arguments trong lab cần redeclare queue khi đổi policy:
   <https://www.rabbitmq.com/docs/dlx>
6. **PostgreSQL — Explicit Locking / Advisory Locks** — session advisory lock để serialize job và nhả khi session kết thúc:
   <https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS>
7. **PostgreSQL — Constraints** — UNIQUE(job_id), khóa ngoại và ràng buộc dữ liệu:
   <https://www.postgresql.org/docs/17/ddl-constraints.html>
8. **amqplib — Channel API** — ConfirmChannel, mandatory publish, consume/noAck, get và ack:
   <https://amqp-node.github.io/amqplib/channel_api.html>

Các giới hạn về transaction DB/broker và side effect bên ngoài được nêu trong ARCHITECTURE.md, phù hợp ba khoảng hở của đề. Không dùng thuật ngữ exactly-once để mô tả lời gọi LLM.
