import { Server } from 'proxy-chain';
/** Authenticated HTTP(S)/SOCKS upstreams are delegated to a maintained proxy implementation. */
export class ProxyForwarder {
  private closing?: Promise<void>;
  private constructor(
    readonly server: Server,
    readonly url: string,
  ) {}
  static async create(upstream: string): Promise<ProxyForwarder> {
    const parsed = new URL(upstream);
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:', 'socks5h:'].includes(parsed.protocol))
      throw new TypeError('Unsupported upstream proxy protocol');
    const server = new Server({
      host: '127.0.0.1',
      port: 0,
      prepareRequestFunction: () => ({ upstreamProxyUrl: upstream, requestAuthentication: false }),
    });
    await server.listen();
    return new ProxyForwarder(server, `http://127.0.0.1:${server.port}`);
  }
  close(): Promise<void> {
    return (this.closing ??= this.server.close(true));
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
