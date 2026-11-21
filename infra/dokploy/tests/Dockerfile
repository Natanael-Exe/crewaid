FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 iptables iproute2 procps && rm -rf /var/lib/apt/lists/*
RUN touch /crewaid-isolated-firewall-test
COPY infra/dokploy /test/infra/dokploy
CMD ["python3", "/test/infra/dokploy/tests/uplink_probe.py"]
