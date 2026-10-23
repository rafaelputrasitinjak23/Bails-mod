import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function toBuffer(audioInput) {
    if (Buffer.isBuffer(audioInput)) return audioInput;
    if (typeof audioInput === 'string') {
        if (fs.existsSync(audioInput)) return fs.readFileSync(audioInput);
        if (/^https?:\/\//i.test(audioInput)) {
            const res = await fetch(audioInput);
            return Buffer.from(await res.arrayBuffer());
        }
    }
    if (audioInput && typeof audioInput === 'object') {
        if (Buffer.isBuffer(audioInput.buffer)) return audioInput.buffer;
        if (audioInput.url) {
            const urlStr = audioInput.url.toString();
            if (fs.existsSync(urlStr)) return fs.readFileSync(urlStr);
            if (/^https?:\/\//i.test(urlStr)) {
                const res = await fetch(urlStr);
                return Buffer.from(await res.arrayBuffer());
            }
        }
        if (typeof audioInput[Symbol.asyncIterator] === 'function' || typeof audioInput.pipe === 'function') {
            const chunks = [];
            for await (const chunk of audioInput) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            return Buffer.concat(chunks);
        }
    }
    throw new Error('Input audio tidak valid.');
}

function generateFallbackWaveform(buffer) {
    const bars = 64;
    const waveform = new Uint8Array(bars);
    for (let i = 0; i < bars; i++) {
        const edgeFactor = Math.sin((i / (bars - 1)) * Math.PI);
        const seed = buffer && buffer.length > i ? buffer[i * Math.floor(buffer.length / bars)] : Math.random() * 100;
        const val = Math.floor(((seed % 70) + 20) * edgeFactor);
        waveform[i] = Math.min(100, Math.max(5, val));
    }
    return waveform;
}

export async function generateWaveform(inputBuffer) {
    const tmpId = crypto.randomBytes(6).toString('hex');
    const tmpIn = path.join(os.tmpdir(), `baileys_wf_in_${tmpId}.tmp`);
    const tmpPcm = path.join(os.tmpdir(), `baileys_wf_out_${tmpId}.pcm`);

    try {
        fs.writeFileSync(tmpIn, inputBuffer);
        await execAsync(`ffmpeg -y -i "${tmpIn}" -ac 1 -ar 8000 -f u8 "${tmpPcm}"`);
        const pcmData = fs.readFileSync(tmpPcm);

        const bars = 64;
        const blockSize = Math.floor(pcmData.length / bars);
        if (blockSize < 1) return generateFallbackWaveform(inputBuffer);

        const rawPoints = [];
        for (let i = 0; i < bars; i++) {
            let sum = 0;
            const start = i * blockSize;
            for (let j = 0; j < blockSize; j++) {
                sum += Math.abs(pcmData[start + j] - 128);
            }
            rawPoints.push(sum / blockSize);
        }

        const maxAmp = Math.max(...rawPoints, 1);
        const waveform = new Uint8Array(bars);
        for (let i = 0; i < bars; i++) {
            waveform[i] = Math.min(100, Math.max(0, Math.round((rawPoints[i] / maxAmp) * 100)));
        }
        return waveform;
    } catch {
        return generateFallbackWaveform(inputBuffer);
    } finally {
        if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
        if (fs.existsSync(tmpPcm)) fs.unlinkSync(tmpPcm);
    }
}

export async function convertToOpus(inputBuffer) {
    const tmpId = crypto.randomBytes(6).toString('hex');
    const tmpIn = path.join(os.tmpdir(), `baileys_aud_in_${tmpId}.tmp`);
    const tmpOut = path.join(os.tmpdir(), `baileys_aud_out_${tmpId}.ogg`);

    try {
        fs.writeFileSync(tmpIn, inputBuffer);
        const { stderr } = await execAsync(
            `ffmpeg -y -i "${tmpIn}" -vn -c:a libopus -b:a 64k -vbr on -compression_level 10 -application voip -ar 48000 -ac 1 "${tmpOut}"`
        );

        const outBuffer = fs.readFileSync(tmpOut);
        let seconds = 0;
        const durMatch = stderr && stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (durMatch) {
            seconds = Math.ceil(
                parseInt(durMatch[1], 10) * 3600 +
                parseInt(durMatch[2], 10) * 60 +
                parseFloat(durMatch[3])
            );
        }
        if (!seconds || seconds < 1) {
            seconds = Math.max(1, Math.round(outBuffer.length / 6000));
        }

        return { buffer: outBuffer, seconds };
    } catch {
        return {
            buffer: inputBuffer,
            seconds: Math.max(1, Math.round(inputBuffer.length / 8000))
        };
    } finally {
        if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    }
}

export async function processNewsletterAudio(audioInput, existingWaveform, existingSeconds) {
    const rawBuffer = await toBuffer(audioInput);
    const [{ buffer, seconds }, waveform] = await Promise.all([
        convertToOpus(rawBuffer),
        existingWaveform ? Promise.resolve(existingWaveform) : generateWaveform(rawBuffer)
    ]);

    return {
        buffer,
        seconds: existingSeconds || seconds,
        waveform,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true
    };
}
