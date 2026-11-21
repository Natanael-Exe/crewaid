FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 iptables iproute2 procps kmod && rm -rf /var/lib/apt/lists/*
RUN touch /crewaid-isolated-firewall-test
COPY infra/compose /test/infra/compose
CMD ["python3", "/test/infra/compose/tests/namespace_probe.py"]
