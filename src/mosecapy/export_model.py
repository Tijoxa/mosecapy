import math
from pathlib import Path

import demucs.htdemucs
import demucs.spec
import torch
import torch as th
import torch.nn.functional as F
from demucs.htdemucs import HTDemucs
from demucs.pretrained import get_model
from torch.export import Dim


def spectro_onnx(x, n_fft=512, hop_length=None, pad=0):
    *other, length = x.shape
    x = x.reshape(-1, length)
    # return_complex=False returns a real tensor of shape (..., F, T, 2)
    z_real = th.stft(
        x,
        n_fft * (1 + pad),
        hop_length or n_fft // 4,
        window=th.hann_window(n_fft).to(x),
        win_length=n_fft,
        normalized=True,
        center=True,
        return_complex=False,  # <--- ONNX compatible!
        pad_mode="reflect",
    )
    # Convert to complex64 for the rest of HTDemucs layers
    z = th.view_as_complex(z_real)
    _, freqs, frame = z.shape
    return z.view(*other, freqs, frame)


def ispectro_onnx(z, hop_length=None, length=None, pad=0):
    *other, freqs, frames = z.shape
    n_fft = 2 * freqs - 2
    z = z.view(-1, freqs, frames)
    win_length = n_fft // (1 + pad)
    # Convert complex z to real representation for istft
    x = th.istft(
        z,
        n_fft,
        hop_length,
        window=th.hann_window(win_length).to(z.real),
        win_length=win_length,
        normalized=True,
        length=length,
        center=True,
    )
    _, length = x.shape
    return x.view(*other, length)


def _ispec_dynamo_friendly(self, z, length=None, scale=0):
    hl = self.hop_length // (4**scale)

    # 1. Convert complex64 (B, S, C, Fr, T) to real float32 (B, S, C, Fr, T, 2)
    z_real = torch.view_as_real(z)

    # 2. Pad float32 tensor (0,0 for real/imag, 0,0 for T, 0,1 for Fr)
    z_real = F.pad(z_real, (0, 0, 0, 0, 0, 1))

    # 3. Pad float32 tensor (0,0 for real/imag, 2,2 for T)
    z_real = F.pad(z_real, (0, 0, 2, 2))

    # 4. Reconstruct complex64 tensor
    z = torch.view_as_complex(z_real.contiguous())

    pad = hl // 2 * 3
    le = hl * math.ceil(length / hl) + 2 * pad
    x = ispectro_onnx(z, hl, length=le)
    x = x[..., pad : pad + length]
    return x


# Apply the patches to demucs.spec

demucs.spec.spectro = spectro_onnx  # type: ignore
demucs.spec.ispectro = ispectro_onnx  # type: ignore
demucs.htdemucs.spectro = spectro_onnx  # type: ignore
demucs.htdemucs.ispectro = ispectro_onnx  # type: ignore
HTDemucs._ispec = _ispec_dynamo_friendly


def main():
    bag = get_model("htdemucs")
    model: HTDemucs = bag.models[0]
    model.eval()
    export_path = Path.home() / "Documents" / "GitHub_tjx" / "mosecapy" / "public" / "models" / "htdemucs.onnx"
    export_path.parent.mkdir(exist_ok=True, parents=True)

    ts = torch.rand((1, 2, 343980))
    batch_dim = Dim("batch", min=1)

    torch.onnx.export(
        model,
        (ts,),
        export_path,
        input_names=["mix"],
        output_names=["split"],
        dynamic_shapes={"mix": {0: batch_dim}},
        opset_version=18,
        dynamo=True,
        external_data=False,
    )


if __name__ == "__main__":
    main()
