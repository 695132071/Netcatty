using System;
using System.IO;
using System.IO.Pipes;

// A VM-like server with exactly one client slot. Keep the same server handle
// alive between clients so reconnect tests do not race pipe creation/removal.
class SingleInstancePipe {
    static void Main(string[] args) {
        using (var pipe = new NamedPipeServerStream(args[0], PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous)) {
            Console.WriteLine("READY");
            Console.Out.Flush();
            var buffer = new byte[8192];
            while (true) {
                try {
                    pipe.WaitForConnection();
                    int count;
                    while ((count = pipe.Read(buffer, 0, buffer.Length)) > 0) {
                        pipe.Write(buffer, 0, count);
                        pipe.Flush();
                    }
                } catch (IOException error) {
                    // Accept can also see an already-closed late client (ERROR_NO_DATA).
                    int code = error.HResult & 0xffff;
                    if (code != 109 && code != 232 && code != 233) throw;
                } finally {
                    try { pipe.Disconnect(); }
                    catch (InvalidOperationException) { /* Accept failed before connection. */ }
                }
            }
        }
    }
}
