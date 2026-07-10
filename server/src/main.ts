import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix('api');

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);

  new Logger('Tylo').log(`dispatch engine + realtime gateway on http://localhost:${port}`);
}

void bootstrap();
