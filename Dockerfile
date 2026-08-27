FROM oven/bun:1

WORKDIR /app

RUN apt-get update -qq && apt-get install -y -qq git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/Fan-Pier-Labs/openrecord.git /openrecord
COPY package.json ./
COPY src ./src

RUN bun install --production --frozen-lockfile

EXPOSE 8080
ENV PORT=8080
CMD ["bun", "src/index.ts"]
