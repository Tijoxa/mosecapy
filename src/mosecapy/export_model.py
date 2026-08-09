import math
from pathlib import Path

import demucs.htdemucs
import demucs.spec
import onnx
import torch
import torch.nn.functional as F
from demucs.htdemucs import HTDemucs
from demucs.pretrained import get_model
from onnx import TensorProto, helper
from torch.export import Dim


def spectro_onnx(x, n_fft=512, hop_length=None, pad=0):
    *other, length = x.shape
    x = x.reshape(-1, length)
    # return_complex=False returns a real tensor of shape (..., F, T, 2)
    z_real = torch.stft(
        x,
        n_fft * (1 + pad),
        hop_length or n_fft // 4,
        window=torch.hann_window(n_fft).to(x),
        win_length=n_fft,
        normalized=True,
        center=True,
        return_complex=False,  # <--- ONNX compatible!
        pad_mode="reflect",
    )
    # Convert to complex64 for the rest of HTDemucs layers
    z = torch.view_as_complex(z_real)
    _, freqs, frame = z.shape
    return z.view(*other, freqs, frame)


def ispectro_onnx(z, hop_length=None, length=None, pad=0):
    *other, freqs, frames = z.shape
    n_fft = 2 * freqs - 2
    z = z.view(-1, freqs, frames)
    win_length = n_fft // (1 + pad)
    # Convert complex z to real representation for istft
    x = torch.istft(
        z,
        n_fft,
        hop_length,
        window=torch.hann_window(win_length).to(z.real),
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


def make_scatternd_indices_web_compatible(onnx_model: onnx.ModelProto) -> int:
    """Cast Dynamo-exported ScatterND indices from int32 to int64.

    PyTorch's Dynamo exporter can emit int32 indices for `_unsafe_index_put`,
    but the ONNX ScatterND schema—and therefore ONNX Runtime Web—requires
    int64 indices. Apply the correction as part of export so the generated
    artifact can be loaded by the browser without a separate patch step.
    """
    value_types = {
        value.name: value.type.tensor_type.elem_type
        for value in [*onnx_model.graph.input, *onnx_model.graph.output, *onnx_model.graph.value_info]
    }
    patched = 0

    for node in list(onnx_model.graph.node):
        if node.op_type != "ScatterND" or value_types.get(node.input[1]) != TensorProto.INT32:
            continue

        source_name = node.input[1]
        cast_name = f"{source_name}_int64"
        cast_node = helper.make_node(
            "Cast",
            inputs=[source_name],
            outputs=[cast_name],
            name=f"web_cast_{source_name}",
            to=TensorProto.INT64,
        )
        node_index = list(onnx_model.graph.node).index(node)
        onnx_model.graph.node.insert(node_index, cast_node)
        node.input[1] = cast_name
        patched += 1

    return patched


def main():
    bag = get_model("htdemucs")
    model: HTDemucs = bag.models[0]
    model.eval()
    export_path = Path(__file__).parents[2] / "public" / "models" / "htdemucs.onnx"
    export_path.parent.mkdir(exist_ok=True, parents=True)

    ts = torch.rand((1, 2, 343980))
    batch_dim = Dim("batch", min=1)

    onnx_program = torch.onnx.export(
        model,
        (ts,),
        f=None,
        input_names=["mix"],
        output_names=["split"],
        dynamic_shapes={"mix": {0: batch_dim}},
        opset_version=18,
        dynamo=True,
        external_data=False,
    )

    if onnx_program is None:
        raise ValueError

    onnx_model = onnx_program.model_proto
    patched = make_scatternd_indices_web_compatible(onnx_model)
    onnx.checker.check_model(onnx_model)

    onnx.save_model(onnx_model, export_path, save_as_external_data=False)
    print(f"Exported web-compatible model to {export_path} ({patched} ScatterND casts added).")


if __name__ == "__main__":
    main()
