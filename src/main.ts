import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const logger = new Logger('mv-studio-worker');
  logger.log('mv-studio-worker 已启动（Pull 模式）');
  process.on('SIGINT', () => void app.close());
  process.on('SIGTERM', () => void app.close());
}

bootstrap();
