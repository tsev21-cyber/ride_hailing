import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: true });
  app.setGlobalPrefix('api');

  // In production this one service also serves the built web app, so the whole
  // demo runs from a single origin: the browser talks to /api and /socket.io on
  // the very same host it loaded the page from — no cross-origin, no config.
  const webDist = join(__dirname, '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    app.useStaticAssets(webDist);
    const express = app.getHttpAdapter().getInstance();
    // SPA fallback: any GET that isn't the API or the socket returns index.html.
    express.get(/^\/(?!api\/|socket\.io\/).*/, (_req: unknown, res: { sendFile: (p: string) => void }) =>
      res.sendFile(join(webDist, 'index.html')));
    new Logger('Tylo').log(`serving web app from ${webDist}`);
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');

  new Logger('Tylo').log(`dispatch engine + realtime gateway + web on http://localhost:${port}`);
}

void bootstrap();
