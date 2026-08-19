import { Greeter } from './types.js';

export class EnglishGreeter implements Greeter {
  private prefix: string;

  constructor(prefix: string = 'Hello') {
    this.prefix = prefix;
  }

  greet(name: string): string {
    return `${this.prefix}, ${name}!`;
  }
}
