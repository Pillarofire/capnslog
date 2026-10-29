importScripts('/vendor/argon2.umd.min.js');

onmessage = async (e) => {
  try {
    const { pass, salt, m, t, p } = e.data;
    const bits = await hashwasm.argon2id({
      password: pass, salt, parallelism: p, iterations: t, memorySize: m, hashLength: 32, outputType: 'binary',
    });
    postMessage({ bits }, [bits.buffer]);
  } catch (err) {
    postMessage({ error: String(err) });
  }
};
