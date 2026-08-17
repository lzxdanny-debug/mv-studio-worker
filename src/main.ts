import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BUILD_INFO } from './generated/build-info';
import { startWorkerHttpProbe } from './worker-http-probe';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const logger = new Logger('mv-studio-worker');
  logger.log(
    `mv-studio-worker 已启动 v${BUILD_INFO.version} (${BUILD_INFO.gitSha}) · built ${BUILD_INFO.buildTime}`,
  );
  startWorkerHttpProbe(logger);
  process.on('SIGINT', () => void app.close());
  process.on('SIGTERM', () => void app.close());
}

bootstrap();
