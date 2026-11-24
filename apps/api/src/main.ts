import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule);
app.enableCors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',') });
app.enableShutdownHooks();
const port = Number(process.env.PORT ?? 4000);
await app.listen(port);
console.log(`API FuelPrice Control sur http://localhost:${port}`);
