# use of moseca
[Reddit post](https://www.reddit.com/r/opensource/comments/15x3e52/from_frustration_to_creation_how_i_built_my_own/)

[GitHub](https://github.com/fabiogra/moseca?tab=readme-ov-file)

[Model download](https://huggingface.co/fabiogra/baseline_vocal_remover)

- requirements.in

```Bash
streamlit==1.22.*
demucs==4.0.0
pandas==1.5.3
pydub==0.25.1
pytube==12.1.3
streamlit-player==0.1.5
yt-dlp==2023.7.6
matplotlib==3.7.1
librosa==0.10.0.post2
resampy==0.4.2
stqdm==0.0.5
streamlit_option_menu==0.3.6
htbuilder==0.6.1
loguru==0.7.0
```

## Setup
- Download model, and put the weight file in project root.
- Create `music` folder and put flac/m4a/mp3 files in there.
- Run `uv run mosecapy.py` and it should work.
