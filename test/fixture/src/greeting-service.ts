import { EnglishGreeter } from './english-greeter.js';
import { logCall } from './decorators.js';

export class GreetingService {
  private greeter: EnglishGreeter;

  constructor() {
    this.greeter = new EnglishGreeter();
  }

  @logCall
  sayHello(name: string): string {
    return this.greeter.greet(name);
  }
}
