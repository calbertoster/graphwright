import { GreetingService } from './greeting-service.js';
import { DEFAULT_NAME } from './constants.js';

export function runDemo(): string {
  const service = new GreetingService();
  return service.sayHello(DEFAULT_NAME);
}
